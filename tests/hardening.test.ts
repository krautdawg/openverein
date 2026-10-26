import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/** Regression tests for review group G8 (#25-#31). */
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt', iban: 'DE02120300000000202051', taxNumber: '12/345/67890' });
});

describe('review G8', () => {
  it('keeps the club settings from roles without settings rights, but tells communication whether mail is paused', async () => {
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Trainer:in') });
    expect((await trainer.get('/organization')).status).toBe(403);
    expect((await admin.get('/organization')).body.iban).toBe('DE02120300000000202051');
    expect((await admin.get('/messages/status')).body).toEqual({ mailPausedReason: null });
  });

  it('hides the e-invoice address from roles that may not see e-mail addresses, and refuses writing it', async () => {
    const m = (await admin.post('/members', { firstName: 'Erna', lastName: 'Einvoice', joinDate: '2024-01-01' })).body;
    expect((await admin.patch(`/members/${m.id}`, { einvoiceFormat: 'xrechnung', einvoiceAddress: 'rechnung@kunde.example' })).status).toBe(200);
    const adviser = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Steuerberatung') });
    const seen = (await adviser.get(`/members/${m.id}`)).body;
    expect(seen.restricted).toContain('email');
    expect(seen.einvoice.address).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('rechnung@kunde.example');
  });

  it('refuses VAT on invoices of a small business (§ 19 UStG)', async () => {
    await admin.patch('/organization', { smallBusiness: true });
    const m = (await admin.post('/members', { firstName: 'Klara', lastName: 'Klein', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body;
    const vat = (await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Hallenmiete', unitCents: 11900, taxRate: 19 }] })).body;
    const issued = await admin.post(`/invoices/${vat.id}/issue`, {});
    expect(issued.status).toBe(400);
    expect(issued.body.title).toContain('§ 19 UStG');
    const plain = (await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 6000 }] })).body;
    expect((await admin.post(`/invoices/${plain.id}/issue`, {})).status).toBe(200);
  });
});
