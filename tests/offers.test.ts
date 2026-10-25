import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let adminCookie: string;
let memberId: string;
beforeEach(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
  memberId = (await admin.post('/members', { firstName: 'Ole', lastName: 'Offerte', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body.id;
});

describe('offers', () => {
  it('issues an offer with its own number, freezes it, and converts it once into an invoice draft', async () => {
    const o = await admin.post('/offers', { memberId, lines: [{ text: 'Vereinsheim Samstag', unitCents: 15000 }, { text: 'Endreinigung', unitCents: 4202, taxRate: 19, net: true }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(o.body).toMatchObject({ status: 'draft', number: null, totalCents: 20000 });
    expect((await admin.post(`/offers/${o.body.id}/convert`, {})).status).toBe(409);
    const issued = await admin.post(`/offers/${o.body.id}/issue`, { issueDate: '2026-10-01' });
    expect(issued.body).toMatchObject({ status: 'sent', number: 'A-2026-0001', validUntil: '2026-10-31' });
    const pdf = await ctx.app.inject({ url: `/api/v1/offers/${o.body.id}/pdf`, headers: { cookie: adminCookie } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin.patch(`/offers/${o.body.id}`, { coverText: 'neu' })).status).toBe(409);
    await expect(ctx.db.updateTable('offer').set({ total_cents: 1 }).where('id', '=', o.body.id).execute()).rejects.toThrow(/immutable/);
    expect((await admin.post(`/offers/${o.body.id}/accept`, {})).body.status).toBe('accepted');
    const conv = await admin.post(`/offers/${o.body.id}/convert`, {});
    expect(conv.status).toBe(201);
    const inv = (await admin.get(`/invoices/${conv.body.invoiceId}`)).body;
    // A draft fixes its total at issue; the lines carry the amounts.
    expect(inv.status).toBe('draft');
    expect(inv.lines.reduce((t: number, l: { totalCents: number }) => t + l.totalCents, 0)).toBe(20000);
    expect(inv.coverText).toContain('A-2026-0001');
    expect((await admin.post(`/offers/${o.body.id}/convert`, {})).status).toBe(409);
    // Offers are no receivables: they do not show up as invoices.
    expect(((await admin.get('/invoices?status=all')).body.items as unknown[]).length).toBe(1);
  });

  it('needs club-wide invoice rights', async () => {
    const tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Kassenwart', [tennis]) });
    expect((await lead.get('/offers')).status).toBe(403);
    expect((await lead.post('/offers', { memberId, lines: [{ text: 'x', unitCents: 100 }] })).status).toBe(403);
  });
});
