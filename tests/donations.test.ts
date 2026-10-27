import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processQueue } from '../src/server/mail/worker.ts';
import { setMailer } from '../src/server/mail/transport.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
let acc: (n: string) => string;
// A notice from last year keeps the tests valid in later years.
const settings = { kind: 'freistellung', office: 'Musterstadt', taxNumber: '12/345/67890', date: `${new Date().getFullYear() - 1}-05-01`, period: '2021–2023', purposes: 'des Sports (§ 52 Abs. 2 Satz 1 Nr. 21 AO)', signer: 'Erika Mustermann, Kassenwartin' };
const donor = { lastName: 'Krause', firstName: 'Bernd', street: 'Bäckerweg 3', postalCode: '12345', city: 'Musterstadt' };

beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
  const accounts = (await admin.get('/ledger/accounts')).body as { id: string; number: string }[];
  acc = (n) => accounts.find((a) => a.number === n)!.id;
});

describe('donations', () => {
  it('records a donation with its booking, refuses receipts without exemption data, issues and cancels one', async () => {
    const d = await admin.post('/donations', { donor, date: '2026-03-05', amountCents: 25000, moneyAccountId: acc('1100'), incomeAccountId: acc('4100') });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.journalNumber).toBe(1);
    const issue = () => admin.post('/donation-receipts', { personId: d.body.personId, donationIds: [d.body.id] });
    expect((await issue()).body.type).toContain('exemption-missing');
    await admin.put('/donations/settings', settings);
    const r = await issue();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'single', totalCents: 25000, number: expect.stringMatching(/^ZB-\d{4}-0001$/) });
    const pdf = await ctx.app.inject({ url: `/api/v1/donation-receipts/${r.body.id}/pdf`, headers: { cookie } });
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // No second receipt for the same donation, no deleting it, no editing the receipt.
    expect((await issue()).status).toBe(409);
    expect((await admin.post(`/donations/${d.body.id}/void`, { reason: 'falsch erfasst' })).status).toBe(409);
    await expect(ctx.db.updateTable('donation_receipt').set({ total_cents: 1 }).execute()).rejects.toThrow(/immutable/);
    // Cancel, then the donation can be confirmed again.
    expect((await admin.post(`/donation-receipts/${r.body.id}/cancel`, { reason: 'Name falsch geschrieben' })).body.status).toBe('cancelled');
    expect((await issue()).status).toBe(201);
  });

  it('voids a wrong donation after its receipt was cancelled, reverses its booking, and finds past donors', async () => {
    await admin.put('/donations/settings', settings);
    const d = await admin.post('/donations', { donor, date: '2026-03-05', amountCents: 100000, moneyAccountId: acc('1100'), incomeAccountId: acc('4100') });
    const r = await admin.post('/donation-receipts', { personId: d.body.personId, donationIds: [d.body.id] });
    await admin.post(`/donation-receipts/${r.body.id}/cancel`, { reason: 'Betrag falsch erfasst' });
    expect((await admin.post(`/donations/${d.body.id}/void`, { reason: 'Betrag falsch erfasst' })).status).toBe(204);
    expect((await admin.get('/donations?year=2026')).body).toHaveLength(0);
    expect((await admin.post('/donation-receipts/annual', { year: 2026 })).body.issued).toBe(0);
    const journal = (await admin.get('/ledger/entries?from=2026-01-01&to=2030-12-31')).body as { source: string; reversedBy: number | null }[];
    expect(journal.find((e) => e.source === 'donation')!.reversedBy).not.toBeNull();
    expect((await admin.get('/donations/donors?q=krau')).body).toEqual([expect.objectContaining({ personId: d.body.personId, name: 'Bernd Krause' })]);
    // Donation postings are corrected at the donation.
    const entry = (await admin.get('/ledger/entries?from=2026-01-01&to=2030-12-31')).body.find((e: { source: string }) => e.source === 'donation');
    expect((await admin.post(`/ledger/entries/${entry.id}/reverse`, {})).status).toBe(409);
  });

  it('runs the annual receipts as collective receipts per donor and skips donors without address', async () => {
    await admin.put('/donations/settings', settings);
    const a = await admin.post('/donations', { donor, date: '2026-01-10', amountCents: 5000 });
    await admin.post('/donations', { personId: a.body.personId, date: '2026-06-10', amountCents: 7000, waiver: true });
    const m = (await admin.post('/members', { lastName: 'Ohneadresse', joinDate: '2024-01-01' })).body;
    await admin.post('/donations', { personId: m.personId, date: '2026-02-01', amountCents: 1000 });
    const run = await admin.post('/donation-receipts/annual', { year: 2026 });
    expect(run.body.issued).toBe(1);
    expect(run.body.skipped).toEqual([{ donorName: 'Ohneadresse', reason: expect.stringContaining('Anschrift') }]);
    const receipts = (await admin.get('/donation-receipts?year=2026')).body;
    expect(receipts[0]).toMatchObject({ kind: 'collective', totalCents: 12000, donationCount: 2 });
  });

  it('refuses receipts on an exemption notice older than five years', async () => {
    await admin.put('/donations/settings', { ...settings, date: '2019-01-01' });
    const d = await admin.post('/donations', { donor, date: '2026-03-05', amountCents: 1000 });
    expect((await admin.post('/donation-receipts', { personId: d.body.personId, donationIds: [d.body.id] })).body.type).toContain('exemption-expired');
  });

  it('records in-kind donations without booking, confirms each on its own template, and keeps them out of collective receipts', async () => {
    await admin.put('/donations/settings', settings);
    const inKind = { description: 'Zehn Fußbälle Größe 5, neu, Kaufpreis laut Rechnung 250 €', source: 'private', valuationDocs: true };
    expect((await admin.post('/donations', { donor, date: '2026-03-01', amountCents: 25000, inKind, moneyAccountId: acc('1000'), incomeAccountId: acc('4600') })).status).toBe(400);
    const goods = await admin.post('/donations', { donor, date: '2026-03-01', amountCents: 25000, inKind });
    expect(goods.status, JSON.stringify(goods.body)).toBe(201);
    expect(goods.body).toMatchObject({ inKind, journalNumber: null });
    const money = await admin.post('/donations', { personId: goods.body.personId, date: '2026-04-01', amountCents: 5000 });
    expect((await admin.post('/donation-receipts', { personId: goods.body.personId, donationIds: [goods.body.id, money.body.id] })).status).toBe(400);
    const run = await admin.post('/donation-receipts/annual', { year: 2026 });
    expect(run.body.issued).toBe(2);
    const templates = await ctx.db.selectFrom('donation_receipt').select(['template', 'kind', 'total_cents']).orderBy('total_cents').execute();
    expect(templates).toEqual([
      { template: 'BMF-Muster Geldzuwendung (Stand 2023)', kind: 'single', total_cents: 5000 },
      { template: 'BMF-Muster Sachzuwendung (Stand 2023)', kind: 'single', total_cents: 25000 },
    ]);
  });

  it('sends receipts by e-mail with the PDF and collects the rest as one letter PDF', async () => {
    setMailer(null);
    await admin.put('/donations/settings', settings);
    const withMail = await admin.post('/donations', { donor: { ...donor, email: 'spender@example.org' }, date: '2026-03-01', amountCents: 10000 });
    const withoutMail = await admin.post('/donations', { donor: { ...donor, lastName: 'Papier' }, date: '2026-03-02', amountCents: 2000 });
    await admin.post('/donation-receipts/annual', { year: 2026 });
    const receipts = (await admin.get('/donation-receipts?year=2026')).body as { id: string; personId: string }[];
    expect(receipts).toHaveLength(2);
    // Two sends at once (double click): each receipt goes out once.
    const [sent, twin] = await Promise.all([admin.post('/donation-receipts/send', { receiptIds: receipts.map((r) => r.id) }), admin.post('/donation-receipts/send', { receiptIds: receipts.map((r) => r.id) })]);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.sent + twin.body.sent).toBe(1);
    expect((sent.body.sent ? sent : twin).body).toMatchObject({ sent: 1, alreadySent: 0, toPrint: [expect.objectContaining({ reason: 'keine E-Mail-Adresse' })] });
    expect((await admin.post('/donation-receipts/send', { receiptIds: receipts.map((r) => r.id) })).body.alreadySent).toBe(1);
    await processQueue(ctx.db);
    const found = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:spender@example.org')}`)).json()).messages as { Subject: string; Attachments: number }[];
    expect(found[0]).toMatchObject({ Attachments: 1 });
    expect(found[0]!.Subject).toMatch(/^Deine Zuwendungsbestätigung ZB-2026/);
    const letters = await ctx.app.inject({ method: 'POST', url: '/api/v1/donation-receipts/letters.pdf', headers: { cookie, 'content-type': 'application/json' }, payload: { receiptIds: [sent.body.toPrint[0].receiptId] } });
    expect(letters.statusCode).toBe(200);
    expect(letters.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(withMail.status + withoutMail.status).toBe(402);
  });
});
