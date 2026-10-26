import { sql } from 'kysely';
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

  // ---------- review G9 ----------

  it('gives the e-invoice XML only to roles that may see what it contains', async () => {
    await admin.patch('/organization', { email: 'kasse@example.org', vatId: 'DE123456789', einvoiceContactName: 'Erika Mustermann', einvoiceContactPhone: '+49 30 1234567' });
    const m = (await admin.post('/members', { lastName: 'Stadt', street: 'Weg 2', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body;
    await admin.patch(`/members/${m.id}`, { einvoiceFormat: 'xrechnung', buyerReference: '04011000-12345-67', einvoiceAddress: 'rechnung@stadt.example' });
    const inv = (await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Hallennutzung', unitCents: 11900, taxRate: 19 }] })).body;
    expect((await admin.post(`/invoices/${inv.id}/issue`, {})).status).toBe(200);
    const xml = (c: string) => ctx.app.inject({ url: `/api/v1/invoices/${inv.id}/xrechnung.xml`, headers: { cookie: c } });
    // A transfer invoice has no member IBAN: a role without IBAN rights still gets it …
    expect((await xml(await userWithRole(ctx.app, cookie, 'Abteilungsleitung'))).statusCode).toBe(200);
    // … but the buyer's e-invoice address is in every XML.
    expect((await xml(await userWithRole(ctx.app, cookie, 'Steuerberatung'))).statusCode).toBe(403);
  });

  it('hides gender like other restricted fields, and keeps the census from roles without birth date or gender', async () => {
    const m = (await admin.post('/members', { firstName: 'Gina', lastName: 'Gender', gender: 'female', birthDate: '1990-01-01', joinDate: '2024-01-01' })).body;
    const adviser = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Steuerberatung') });
    const seen = (await adviser.get(`/members/${m.id}`)).body;
    expect(seen.restricted).toContain('gender');
    expect(seen).not.toHaveProperty('gender');
    expect((await adviser.get(`/reports/census?year=${new Date().getFullYear()}`)).status).toBe(403);
    expect((await admin.get(`/members/${m.id}`)).body.gender).toBe('female');
  });

  it('exports every person column in the Art. 15 answer (or names why not)', async () => {
    const { PERSON_EXPORT, PERSON_NOT_EXPORTED } = await import('../src/server/routes/privacy.ts');
    const cols = (await sql<{ c: string }>`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'person'`.execute(ctx.db)).rows.map((r) => r.c);
    expect(cols.filter((c) => !(c in PERSON_EXPORT) && !PERSON_NOT_EXPORTED.includes(c))).toEqual([]);
  });

  // ---------- review G10 ----------

  it('escapes every line break in vCards and folds long lines', async () => {
    const { vcard } = await import('../src/server/members/lists.ts');
    const card = vcard({ kind: 'natural', firstName: 'Eve', lastName: 'Evil\rURL:https://attacker.example', companyName: null, street: 'Straße mit einem sehr langen Namen, die über die fünfundsiebzig Oktette hinausgeht', postalCode: '12345', city: 'Ort', country: 'DE', org: 'TSV' });
    const lines = card.split('\r\n');
    expect(lines.some((l) => l.startsWith('URL:'))).toBe(false);
    expect(card.replace(/\r\n /g, '')).toContain('Evil\\nURL:https://attacker.example');
    expect(lines.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it('refuses in-kind receipts without valuation documents for private goods, and descriptions that do not fit', async () => {
    const donor = { lastName: 'Sach', firstName: 'Sara', street: 'Weg 3', postalCode: '12345', city: 'Musterstadt' };
    const base = { donor, date: '2026-03-01', amountCents: 25000 };
    expect((await admin.post('/donations', { ...base, inKind: { description: 'Zehn Bälle', source: 'private', valuationDocs: false } })).status).toBe(400);
    const long = 'Sehr ausführliche Beschreibung der Sachspende mit Alter, Zustand und Kaufpreis. '.repeat(6);
    expect((await admin.post('/donations', { ...base, inKind: { description: long, source: 'business', valuationDocs: false } })).status).toBe(400);
    expect((await admin.post('/donations', { ...base, inKind: { description: 'Zehn Bälle, neu', source: 'private', valuationDocs: true } })).status).toBe(201);
  });
});
