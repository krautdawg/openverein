import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp } from './helpers.ts';

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
});
