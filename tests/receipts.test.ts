import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

config.filesDir = await mkdtemp(join(tmpdir(), 'ov-receipts-'));
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
let acc: (n: string) => string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  const accounts = (await admin.get('/ledger/accounts')).body as { id: string; number: string }[];
  acc = (n) => accounts.find((a) => a.number === n)!.id;
});

const upload = (name: string, bytes: Buffer) => ctx.app.inject({ method: 'POST', url: `/api/v1/receipts/files?name=${encodeURIComponent(name)}`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf' }, payload: bytes });

describe('receipts', () => {
  it('records a receipt with its file, warns on duplicates, posts it when paid and reverses it when voided', async () => {
    const pdf = Buffer.from('%PDF-1.4 Hallenmiete April');
    const f = await upload('miete.pdf', pdf);
    expect(f.statusCode, f.body).toBe(201);
    const create = (number: string, fileId?: string) => admin.post('/receipts', { supplier: 'Stadt Musterstadt', number, receiptDate: '2026-04-01', fileId, lines: [{ grossCents: 48000, accountId: acc('6200') }] });
    const r = await create('RE-77', f.json().id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.receipt).toMatchObject({ status: 'open', totalCents: 48000, hasFile: true });
    expect(r.body.warnings).toEqual([]);
    const copy = await upload('kopie.pdf', pdf);
    expect(copy.json().duplicateOf).toContain('Stadt Musterstadt');
    expect((await create('RE-77')).body.warnings[0]).toContain('schon einen Beleg mit der Nummer RE-77');
    // One file, one receipt; receipt files stay out of the document module.
    expect((await create('RE-78', f.json().id)).status).toBe(409);
    expect((await admin.get('/files')).body.items ?? (await admin.get('/files')).body).toHaveLength(0);
    // Open receipts can be corrected.
    const edited = await admin.put(`/receipts/${r.body.receipt.id}`, { supplier: 'Stadt Musterstadt', number: 'RE-77', receiptDate: '2026-04-01', fileId: f.json().id, lines: [{ grossCents: 47000, accountId: acc('6200') }] });
    expect(edited.body.receipt.totalCents).toBe(47000);

    const paid = await admin.post(`/receipts/${r.body.receipt.id}/pay`, { date: '2026-04-03', moneyAccountId: acc('1100') });
    expect(paid.body).toMatchObject({ status: 'paid', journalNumber: 1 });
    // Posted receipts are frozen.
    await expect(ctx.db.updateTable('receipt_line').set({ gross_cents: 1 }).execute()).rejects.toThrow(/posted/);
    const file = await ctx.app.inject({ url: `/api/v1/receipts/${r.body.receipt.id}/file`, headers: { cookie } });
    expect(file.rawPayload.equals(pdf)).toBe(true);

    // Voiding books a reversal: a retry with the same key replays the answer instead of "already void".
    const voidOnce = () => ctx.app.inject({ method: 'POST', url: `/api/v1/receipts/${r.body.receipt.id}/void`, headers: { cookie, 'idempotency-key': 'void-key-0001' }, payload: { reason: 'Doppelt erfasst' } });
    expect((await voidOnce()).json().status).toBe('void');
    const again = await voidOnce();
    expect([again.statusCode, again.headers['idempotent-replayed'], again.json().status]).toEqual([200, 'true', 'void']);
    const journal = (await admin.get('/ledger/entries?from=2026-01-01&to=2030-12-31')).body as { source: string; reversesNumber: number | null }[];
    expect(journal.some((e) => e.reversesNumber === 1)).toBe(true);
  });

  it('keeps cash from going negative, writes a self-issued receipt and lists the cash book with running balance', async () => {
    await admin.post('/ledger/bookings', { kind: 'income', date: '2026-02-01', text: 'Kuchenverkauf', moneyAccountId: acc('1000'), lines: [{ grossCents: 3000, accountId: acc('4600') }] });
    const tooMuch = await admin.post('/receipts', { supplier: 'Baumarkt', receiptDate: '2026-02-02', lines: [{ grossCents: 5000, accountId: acc('6100') }], pay: { date: '2026-02-02', moneyAccountId: acc('1000') } });
    expect(tooMuch.status).toBe(409);
    expect(await ctx.db.selectFrom('receipt').select('id').execute()).toHaveLength(0); // all or nothing

    const self = await admin.post('/receipts/self-issued', { date: '2026-02-03', payee: 'Parkhaus am Markt', reason: 'Parkautomat ohne Quittung', text: 'Parken Turnier', amountCents: 1500, accountId: acc('6900'), signer: 'Erika Mustermann', pay: { date: '2026-02-03', moneyAccountId: acc('1000') } });
    expect(self.status, JSON.stringify(self.body)).toBe(201);
    expect(self.body).toMatchObject({ selfIssued: true, status: 'paid', hasFile: true, supplier: 'Parkhaus am Markt' });
    // The receipt's posting is corrected at the receipt, not in the journal.
    const entry = (await admin.get('/ledger/entries?from=2026-01-01&to=2026-12-31')).body.find((e: { source: string }) => e.source === 'receipt');
    expect((await admin.post(`/ledger/entries/${entry.id}/reverse`, {})).status).toBe(409);
    const book = (await admin.get(`/ledger/cash-book?accountId=${acc('1000')}&from=2026-01-01&to=2026-12-31`)).body;
    expect(book.rows.map((r: { balanceCents: number }) => r.balanceCents)).toEqual([3000, 1500]);
    expect(book.rows[1].receiptId).toBe(self.body.id);
    const pdf = await ctx.app.inject({ url: `/api/v1/ledger/cash-book.pdf?accountId=${acc('1000')}&from=2026-01-01&to=2026-12-31`, headers: { cookie } });
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});
