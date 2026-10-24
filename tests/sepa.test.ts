import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addBusinessDays } from '../src/server/sepa/pain.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let adminCookie: string;
let accountId: string;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const CAMT = readFileSync(new URL('./fixtures/camt053-v08.xml', import.meta.url), 'utf8');

beforeEach(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
  await admin.patch('/organization', { creditorId: 'DE98ZZZ09999999999', iban: 'DE89370400440532013000', street: 'Sportplatzweg 1', postalCode: '12345', city: 'Musterstadt', prenotificationDays: 1 });
  accountId = (await admin.post('/bank-accounts', { name: 'Vereinskonto', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', openingDate: '2026-01-01', openingBalanceCents: 100000 })).body.id;
});

/** A member paying by direct debit with an active mandate and one issued invoice due today. */
async function debitor(name: string, iban = 'DE02120300000000202051', cents = 12000) {
  const m = (await admin.post('/members', { lastName: name, firstName: 'Test', joinDate: '2024-01-01' })).body;
  await admin.patch(`/members/${m.id}/payment-method`, { paymentMethod: 'direct_debit' });
  const mandate = await admin.post(`/members/${m.id}/mandates`, { signedOn: '2024-01-15', accountHolder: `Test ${name}`, iban });
  expect(mandate.status, JSON.stringify(mandate.body)).toBe(201);
  const inv = await admin.post('/invoices', { memberId: m.id, dueDate: today(), lines: [{ text: 'Beitrag', unitCents: cents }] });
  await admin.post(`/invoices/${inv.body.id}/issue`, {});
  return { memberId: m.id as string, invoiceId: inv.body.id as string, mandate: mandate.body };
}

const date = () => addBusinessDays(today(), 3);

describe('mandates', () => {
  it('validates IBAN, replaces the active mandate, masks the IBAN for roles without the right', async () => {
    const { memberId, mandate } = await debitor('Becker');
    expect(mandate).toMatchObject({ reference: '0001-1', status: 'active', iban: 'DE02120300000000202051' });
    expect((await admin.post(`/members/${memberId}/mandates`, { signedOn: '2024-01-15', accountHolder: 'X', iban: 'DE02120300000000202052' })).status).toBe(400);
    const second = await admin.post(`/members/${memberId}/mandates`, { signedOn: '2025-01-15', accountHolder: 'Test Becker', iban: 'DE75512108001245126199' });
    expect(second.body.reference).toBe('0001-2');
    const list = (await admin.get(`/members/${memberId}/mandates`)).body;
    expect(list.map((m: { status: string }) => m.status)).toEqual(['active', 'revoked']);
    const adviser = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Steuerberatung', null) });
    const seen = (await adviser.get(`/members/${memberId}/mandates`)).body[0];
    expect(seen.iban).toBeUndefined();
    expect(seen.ibanMasked).toMatch(/^DE•• /);
    const stored = await ctx.db.selectFrom('sepa_mandate').select('iban_encrypted').executeTakeFirstOrThrow();
    expect(stored.iban_encrypted).not.toContain('DE02');
  });
});

describe('collection runs', () => {
  it('generates an XSD-valid pain.008, guards against double debits and needs confirmation to release after download', async () => {
    const a = await debitor('Becker');
    const b = await debitor('Schulz', 'DE75512108001245126199', 1550);
    const c = (await admin.get('/collection-runs/candidates')).body;
    expect(c.map((x: { readiness: string }) => x.readiness)).toEqual(['ok', 'ok']);
    const run = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [a.invoiceId, b.invoiceId] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body).toMatchObject({ status: 'generated', itemCount: 2, totalCents: 13550 });
    expect(run.body.files[0]).toMatchObject({ itemCount: 2, controlSumCents: 13550, sequenceType: 'RCUR' });

    const again = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [a.invoiceId] });
    expect(again.status).toBe(409);
    expect((await admin.get('/collection-runs/candidates')).body[0].readiness).toBe('in_run');

    const file = await ctx.app.inject({ url: `/api/v1/collection-runs/${run.body.id}/files/1`, headers: { cookie: adminCookie } });
    expect(file.body).toContain('<MndtId>0001-1</MndtId>');
    expect(file.body).toContain('<Cd>CORE</Cd>');
    const file2 = await ctx.app.inject({ url: `/api/v1/collection-runs/${run.body.id}/files/1`, headers: { cookie: adminCookie } });
    expect(file2.body).toBe(file.body);
    expect((await admin.get(`/collection-runs/${run.body.id}`)).body.status).toBe('downloaded');

    expect((await admin.post(`/collection-runs/${run.body.id}/release`, { reason: 'Falsches Datum' })).status).toBe(409);
    const released = await admin.post(`/collection-runs/${run.body.id}/release`, { reason: 'Falsches Datum', confirmNotSubmitted: true });
    expect(released.body.status).toBe('released');
    expect((await admin.get('/collection-runs/candidates')).body[0].readiness).toBe('ok');
  });

  it('refuses non-business days, too-short lead times, invoices due later and missing creditor IDs', async () => {
    const a = await debitor('Becker');
    let sunday = date();
    while (new Date(`${sunday}T00:00:00Z`).getUTCDay() !== 0) sunday = new Date(Date.parse(sunday) + 86_400_000).toISOString().slice(0, 10);
    expect((await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: sunday, invoiceIds: [a.invoiceId] })).status).toBe(400);
    expect((await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: today(), invoiceIds: [a.invoiceId] })).status).toBe(400);
    const m = (await admin.post('/members', { lastName: 'Später', joinDate: '2024-01-01' })).body;
    await admin.patch(`/members/${m.id}/payment-method`, { paymentMethod: 'direct_debit' });
    await admin.post(`/members/${m.id}/mandates`, { signedOn: '2024-01-15', accountHolder: 'Test Später', iban: 'DE75512108001245126199' });
    const inv = await admin.post('/invoices', { memberId: m.id, dueDate: '2099-01-01', lines: [{ text: 'Beitrag', unitCents: 1000 }] });
    await admin.post(`/invoices/${inv.body.id}/issue`, {});
    const late = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [inv.body.id] });
    expect(late.status).toBe(400);
    expect(late.body.detail).toContain('Vorabankündigung');
    await admin.patch('/organization', { creditorId: null });
    expect((await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [a.invoiceId] })).body.type).toContain('no-creditor-id');
  });
});

describe('bank import and matching', () => {
  it('settles collection items by end-to-end ID and processes a return debit', async () => {
    const a = await debitor('Becker');
    const b = await debitor('Schulz', 'DE75512108001245126199');
    const run = (await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [a.invoiceId, b.invoiceId] })).body;
    const items = run.items as { endToEndId: string; name: string }[];
    const e2e = (n: string) => items.find((i) => i.name.includes(n))!.endToEndId;
    const xml = CAMT.replaceAll('OV-1-0001', e2e('Becker')).replaceAll('OV-1-0002', e2e('Schulz')).replaceAll('2026-11-02', date()).replaceAll('2026-11-03', date());
    const imp = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', fileName: 'auszug.xml', content: xml });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body).toMatchObject({ imported: 4, duplicates: 0, autoMatched: 2, returns: 1 });
    expect((await admin.get(`/invoices/${a.invoiceId}`)).body.status).toBe('paid');
    const schulz = (await admin.get(`/invoices/${b.invoiceId}`)).body;
    expect(schulz.status).toBe('open');
    const rd = await ctx.db.selectFrom('return_debit').selectAll().executeTakeFirstOrThrow();
    expect(rd).toMatchObject({ reason_code: 'AM04', fee_cents: 300 });
    expect((await admin.get('/collection-runs/candidates')).body.find((x: { invoiceId: string }) => x.invoiceId === b.invoiceId).readiness).toBe('ok');
    const dup = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: xml });
    expect(dup.status).toBe(409);
    const overlap = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: xml.replace('STMT-2026-11-04', 'STMT-OTHER') });
    expect(overlap.body).toMatchObject({ imported: 0, duplicates: 4 });
  });

  it('matches transfers by invoice number, suggests the rest, and lets the treasurer allocate, ignore and undo', async () => {
    const m = (await admin.post('/members', { lastName: 'Hoffmann', firstName: 'Clara', joinDate: '2024-01-01' })).body;
    const inv = await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 3000 }] });
    const issued = (await admin.post(`/invoices/${inv.body.id}/issue`, {})).body;
    const inv2 = await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Trikot', unitCents: 5000 }] });
    const issued2 = (await admin.post(`/invoices/${inv2.body.id}/issue`, {})).body;
    const csv = `Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag
03.11.2026;${issued.number} Clara;Clara Hoffmann;DE02120300000000202051;30,00
04.11.2026;Trikot ${issued2.number};Clara Hoffmann;DE02120300000000202051;20,00
05.11.2026;Kontofuehrung;Bank;;-4,90`;
    const imp = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'csv', content: csv });
    expect(imp.body).toMatchObject({ imported: 3, autoMatched: 1 });
    expect((await admin.get(`/invoices/${inv.body.id}`)).body.status).toBe('paid');
    const inbox = (await admin.get('/bank-transactions')).body as { id: string; amountCents: number; suggestions: { invoiceId: string }[] }[];
    const partial = inbox.find((t) => t.amountCents === 2000)!;
    expect(partial.suggestions[0]!.invoiceId).toBe(inv2.body.id);
    expect((await admin.post(`/bank-transactions/${partial.id}/allocate`, { allocations: [{ invoiceId: inv2.body.id, amountCents: 1000 }] })).status).toBe(400);
    const done = await admin.post(`/bank-transactions/${partial.id}/allocate`, { allocations: [{ invoiceId: inv2.body.id, amountCents: 2000 }] });
    expect(done.body.status).toBe('matched');
    expect((await admin.get(`/invoices/${inv2.body.id}`)).body.status).toBe('partially_paid');
    const fee = inbox.find((t) => t.amountCents === -490)!;
    expect((await admin.post(`/bank-transactions/${fee.id}/ignore`, { note: 'Kontoführungsgebühr' })).body.status).toBe('ignored');
    await admin.post(`/bank-transactions/${partial.id}/unmatch`);
    expect((await admin.get(`/invoices/${inv2.body.id}`)).body.status).toBe('open');
  });

  it('rejects XML with entity declarations and statements for another account', async () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Document/>`;
    expect((await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: evil })).status).toBe(400);
    const other = CAMT.replace('DE89370400440532013000', 'DE02120300000000202051');
    const res = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: other });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('anderen Konto');
  });

  it('trainers and division leads cannot see bank data', async () => {
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Trainer:in', null) });
    expect((await trainer.get('/bank-accounts')).status).toBe(403);
    expect((await trainer.get('/bank-transactions')).status).toBe(403);
  });
});

describe('review fixes', () => {
  const camtEntry = (amount: string, sign: 'CRDT' | 'DBIT', e2e: string | null, text: string, d: string) =>
    `<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${sign}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${d}</Dt></BookgDt><NtryDtls><TxDtls>${e2e ? `<Refs><EndToEndId>${e2e}</EndToEndId></Refs>` : ''}<RmtInf><Ustrd>${text}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
  const camt = (entries: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>${entries}</Stmt></BkToCstmrStmt></Document>`;

  it('a credit-note transfer leaving the account pays the credit note instead of counting as a return', async () => {
    const { memberId } = await debitor('Erstattung');
    const note = await admin.post('/invoices', { memberId, kind: 'credit_note', lines: [{ text: 'Erstattung', unitCents: 3000 }] });
    await admin.post(`/invoices/${note.body.id}/issue`, {});
    const run = await admin.post('/collection-runs', { kind: 'transfer', bankAccountId: accountId, collectionDate: date(), invoiceIds: [note.body.id] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const imp = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: camt(camtEntry('30.00', 'DBIT', run.body.items[0].endToEndId, 'Erstattung', date())) });
    expect(imp.body).toMatchObject({ autoMatched: 1, returns: 0 });
    expect((await admin.get(`/invoices/${note.body.id}`)).body.status).toBe('paid');
    expect((await admin.get('/collection-runs/candidates?kind=transfer')).body).toHaveLength(0);
  });

  it('an invoice in a running debit cannot be paid, cancelled or auto-matched elsewhere', async () => {
    const a = await debitor('Doppelt');
    await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [a.invoiceId] });
    expect((await admin.post(`/invoices/${a.invoiceId}/payments`, { amountCents: 12000, bookedOn: today(), method: 'transfer' })).status).toBe(409);
    expect((await admin.post(`/invoices/${a.invoiceId}/cancel`)).status).toBe(409);
    expect((await admin.post(`/invoices/${a.invoiceId}/write-off`, { reason: 'Test der Sperre' })).status).toBe(409);
    const number = (await admin.get(`/invoices/${a.invoiceId}`)).body.number;
    const imp = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: camt(camtEntry('120.00', 'CRDT', null, `Beitrag ${number}`, date())) });
    expect(imp.body.autoMatched).toBe(0);
    const inbox = (await admin.get('/bank-transactions')).body;
    expect(inbox[0].suggestions).toHaveLength(0);
  });

  it('a one-off mandate is collected once', async () => {
    const m = (await admin.post('/members', { lastName: 'Einmal', joinDate: '2024-01-01' })).body;
    await admin.patch(`/members/${m.id}/payment-method`, { paymentMethod: 'direct_debit' });
    await admin.post(`/members/${m.id}/mandates`, { signedOn: '2024-01-15', accountHolder: 'Test Einmal', iban: 'DE02120300000000202051', type: 'one_off' });
    const ids: string[] = [];
    for (const c of [1000, 2000]) {
      const inv = await admin.post('/invoices', { memberId: m.id, dueDate: today(), lines: [{ text: 'X', unitCents: c }] });
      await admin.post(`/invoices/${inv.body.id}/issue`, {});
      ids.push(inv.body.id);
    }
    expect((await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: ids })).status).toBe(409);
    const run = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [ids[0]] });
    expect(run.body.files[0].sequenceType).toBe('OOFF');
    await ctx.app.inject({ url: `/api/v1/collection-runs/${run.body.id}/files/1`, headers: { cookie: adminCookie } });
    await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: camt(camtEntry('10.00', 'CRDT', run.body.items[0].endToEndId, 'OOFF', date())) });
    expect((await admin.get('/collection-runs/candidates')).body.find((c: { invoiceId: string }) => c.invoiceId === ids[1]).readiness).toBe('no_mandate');
  });

  it('keeps real repeats, refuses balance mismatches without a reason and rolls back only the latest import', async () => {
    const csv = 'Buchungstag;Verwendungszweck;Betrag\n03.11.2026;Beitrag;30,00\n03.11.2026;Beitrag;30,00';
    const first = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'csv', content: csv });
    expect(first.body.imported).toBe(2);
    const second = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'csv', content: csv + '\n04.11.2026;Spende;10,00' });
    expect(second.body).toMatchObject({ imported: 1, duplicates: 2 });
    expect((await admin.del(`/bank-imports/${first.body.id}`)).status).toBe(409);
    expect((await admin.del(`/bank-imports/${second.body.id}`)).status).toBe(204);
    const off = camt(camtEntry('5.00', 'CRDT', null, 'x', '2026-11-05')).replace('</Acct>', '</Acct><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>');
    const blocked = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: off });
    expect(blocked.body.type).toContain('balance-mismatch');
    const forced = await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'camt053', content: off, balanceOverrideReason: 'Auszug vom Vormonat fehlt' });
    expect(forced.status).toBe(201);
  });

  it('refuses to revoke a mandate that is in a running debit and enforces the pre-notification period', async () => {
    const a = await debitor('Frist');
    await admin.patch('/organization', { prenotificationDays: 14 });
    const tooEarly = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [a.invoiceId] });
    expect(tooEarly.body.detail).toContain('Vorabankündigungsfrist');
    await admin.patch('/organization', { prenotificationDays: 1 });
    await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: date(), invoiceIds: [a.invoiceId] });
    expect((await admin.post(`/mandates/${a.mandate.id}/revoke`, { reason: 'Mitglied widerruft' })).status).toBe(409);
  });
});
