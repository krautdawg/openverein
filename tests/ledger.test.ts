import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { splitGross } from '../src/server/ledger/service.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let accounts: { id: string; number: string }[];
const acc = (n: string) => accounts.find((a) => a.number === n)!.id;
beforeEach(async () => {
  await reset(ctx.db);
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
  accounts = (await admin.get('/ledger/accounts')).body;
});

describe('ledger', () => {
  it('splits gross amounts so net plus tax is exact', () => {
    expect(splitGross(11900, 1900)).toEqual({ net: 10000, tax: 1900 });
    expect(splitGross(1000, 700)).toEqual({ net: 935, tax: 65 });
    expect(splitGross(500, 0)).toEqual({ net: 500, tax: 0 });
  });

  it('books a multi-rate expense, keeps the journal append-only and balanced, and reports the EÜR by sphere', async () => {
    const rates = (await admin.get('/ledger/tax-rates')).body as { id: string; rateBp: number; validTo: string | null }[];
    const r19 = rates.find((r) => r.rateBp === 1900 && !r.validTo)!.id;
    const r7 = rates.find((r) => r.rateBp === 700 && !r.validTo)!.id;
    await admin.post('/ledger/bookings', { kind: 'income', date: '2026-03-01', text: 'Spende Bäckerei', moneyAccountId: acc('1100'), lines: [{ grossCents: 50000, accountId: acc('4100') }] });
    const b = await admin.post('/ledger/bookings', { kind: 'expense', date: '2026-03-02', text: 'Einkauf Vereinsfest', moneyAccountId: acc('1100'), lines: [{ grossCents: 11900, accountId: acc('6800'), taxRateId: r19 }, { grossCents: 1070, accountId: acc('6800'), taxRateId: r7 }] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.lines).toHaveLength(5);
    expect(b.body.lines.reduce((s: number, l: { debitCents: number }) => s + l.debitCents, 0)).toBe(12970);

    await expect(ctx.db.updateTable('journal_line').set({ debit_cents: 1 }).execute()).rejects.toThrow(/append-only/);
    await expect(ctx.db.deleteFrom('journal_entry').execute()).rejects.toThrow(/append-only/);
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    await expect(ctx.db.transaction().execute(async (tx) => {
      const e = await tx.insertInto('journal_entry').values({ organization_id: org, number: 99, entry_date: '2026-03-03', text: 'schief', source: 'manual', created_by: null }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('journal_line').values([{ organization_id: org, entry_id: e.id, account_id: acc('1100'), debit_cents: 10000, sphere: 'ideell' }, { organization_id: org, entry_id: e.id, account_id: acc('4100'), credit_cents: 9000, sphere: 'ideell' }]).execute();
    })).rejects.toThrow(/not balanced/);

    const euer = (await admin.get('/ledger/reports/euer?from=2026-01-01&to=2026-12-31')).body;
    expect(euer.totals).toEqual({ incomeCents: 50000, expenseCents: 11000, resultCents: 39000 });
    expect(euer.spheres.find((s: { sphere: string }) => s.sphere === 'wirtschaft').expenseCents).toBe(11000);
    expect(euer.vat.inputCents).toBe(1970);
  });

  it('posts payments on the cash basis and their reversal, and keeps cash from going negative', async () => {
    await admin.patch('/organization', { street: 'Weg 1', postalCode: '12345', city: 'Musterstadt' });
    const m = (await admin.post('/members', { lastName: 'Zahler', joinDate: '2024-01-01' })).body.id;
    const inv = await admin.post('/invoices', { memberId: m, lines: [{ text: 'Beitrag', unitCents: 6000 }] });
    await admin.post(`/invoices/${inv.body.id}/issue`, {});
    // Issuing posts nothing.
    expect((await admin.get('/ledger/entries?from=2020-01-01&to=2030-12-31')).body).toHaveLength(0);
    const paid = await admin.post(`/invoices/${inv.body.id}/payments`, { amountCents: 6000, bookedOn: '2026-02-01', method: 'cash' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const entries = (await admin.get('/ledger/entries?from=2020-01-01&to=2030-12-31')).body;
    expect(entries).toHaveLength(1);
    expect(entries[0].lines.map((l: { accountNumber: string; debitCents: number }) => [l.accountNumber, l.debitCents])).toEqual([['1000', 6000], ['4400', 0]]); // a hand-written invoice is 'other' income

    // Cash: 60 € in, so a 70 € expense is refused, a 50 € one goes through.
    const spend = (cents: number) => admin.post('/ledger/bookings', { kind: 'expense', date: '2026-02-02', text: 'Bälle', moneyAccountId: acc('1000'), lines: [{ grossCents: cents, accountId: acc('6100') }] });
    expect((await spend(7000)).status).toBe(409);
    expect((await spend(5000)).status).toBe(201);
    // Reversing the payment would now leave the cash … it is a reversal of income, booked today; the ledger follows the payment.
    const alloc = (await admin.get(`/invoices/${inv.body.id}`)).body.allocations[0].id;
    await admin.post(`/allocations/${alloc}/reverse`, {});
    const after = (await admin.get('/ledger/entries?from=2020-01-01&to=2030-12-31')).body;
    expect(after.some((e: { source: string }) => e.source === 'allocation_reversal')).toBe(true);
    // Payment postings are corrected at the payment, not in the journal.
    expect((await admin.post(`/ledger/entries/${entries[0].id}/reverse`, {})).status).toBe(409);
  });

  it('locks a period, refuses postings and payments in it, and needs a reason to reopen', async () => {
    const b = await admin.post('/ledger/bookings', { kind: 'income', date: '2025-06-01', text: 'Zuschuss', moneyAccountId: acc('1100'), lines: [{ grossCents: 10000, accountId: acc('4200') }] });
    expect((await admin.post('/ledger/lock', { lockDate: '2025-12-31' })).status).toBe(200);
    expect((await admin.post('/ledger/bookings', { kind: 'income', date: '2025-12-15', text: 'zu spät', moneyAccountId: acc('1100'), lines: [{ grossCents: 100, accountId: acc('4200') }] })).status).toBe(409);
    // A correction of a locked entry is a reversal dated in the open period.
    const rev = await admin.post(`/ledger/entries/${b.body.id}/reverse`, {});
    expect(rev.status, JSON.stringify(rev.body)).toBe(201);
    expect((await admin.post(`/ledger/entries/${b.body.id}/reverse`, {})).status).toBe(409);
    expect((await admin.post('/ledger/lock', { lockDate: '2025-06-30' })).status).toBe(400); // no reason
    expect((await admin.post('/ledger/lock', { lockDate: '2025-06-30', reason: 'Beleg nachgereicht' })).status).toBe(200);
    const audit = await sql<{ action: string }>`select action from audit_event where action like 'ledger.lock%' order by id`.execute(ctx.db);
    expect(audit.rows.map((r) => r.action)).toEqual(['ledger.locked', 'ledger.lock_moved_back']);
  });

  it('books transfers between own accounts without income', async () => {
    await admin.post('/ledger/bookings', { kind: 'income', date: '2026-01-10', text: 'Kuchenverkauf', moneyAccountId: acc('1000'), lines: [{ grossCents: 20000, accountId: acc('4600') }] });
    const t = await admin.post('/ledger/bookings', { kind: 'transfer', date: '2026-01-11', text: 'Einzahlung Bank', fromAccountId: acc('1000'), toAccountId: acc('1100'), amountCents: 20000 });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const euer = (await admin.get('/ledger/reports/euer?from=2026-01-01&to=2026-12-31')).body;
    expect(euer.totals.incomeCents).toBe(20000);
    const balances = (await admin.get('/ledger/reports/balances?from=2026-01-01&to=2026-12-31')).body as { number: string; closingCents: number }[];
    expect(balances.find((b) => b.number === '1000')!.closingCents).toBe(0);
    expect(balances.find((b) => b.number === '1100')!.closingCents).toBe(20000);
    expect(balances.find((b) => b.number === '1360')!.closingCents).toBe(0);
  });
});
