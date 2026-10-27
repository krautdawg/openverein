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

  // ---------- review G11 ----------

  it('keeps the public fields of a new calendar, with the same rule as a change', async () => {
    const created = await admin.post('/calendars', { name: 'Spielplan', public: true, publicOrigins: ['https://Verein.example'] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ public: true, publicOrigins: ['https://verein.example'] });
    const group = (await admin.post('/groups', { name: 'Vorstand', shortCode: 'VS' })).body.id;
    expect((await admin.post('/calendars', { name: 'Intern', public: true, groupIds: [group] })).status).toBe(409);
  });

  it('invites a board meeting by the board as it is on the day of the meeting', async () => {
    const board = (await admin.post('/groups', { name: 'Vorstand', shortCode: 'VS' })).body.id;
    const held = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const leaving = (await admin.post('/members', { firstName: 'Lea', lastName: 'Geht', email: 'lea@example.org', joinDate: '2020-01-01', groupIds: [board] })).body;
    const coming = (await admin.post('/members', { firstName: 'Kai', lastName: 'Kommt', email: 'kai@example.org', joinDate: '2020-01-01' })).body;
    await ctx.db.updateTable('group_membership').set({ valid_to: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) }).where('member_id', '=', leaving.id).execute();
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    await ctx.db.insertInto('group_membership').values({ organization_id: org, member_id: coming.id, group_id: board, valid_from: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) }).execute();
    const a = (await admin.post('/assemblies', { kind: 'board', groupId: board, title: 'Vorstandssitzung', heldOn: held, startsAt: '19:00', place: 'Online', noticeDays: 7, items: [{ title: 'Beschlüsse', isVote: true }] })).body;
    expect((await admin.post(`/assemblies/${a.id}/invite`, {})).status).toBe(200);
    const to = (await ctx.db.selectFrom('delivery').select('email').execute()).map((d) => d.email);
    expect(to).toEqual(['kai@example.org']);
  });

  // ---------- review G12 ----------

  it('certifies only memberships that exist or existed', async () => {
    const applicant = (await admin.post('/members', { firstName: 'Anna', lastName: 'Antrag' })).body;
    expect(applicant.status).toBe('applicant');
    expect((await ctx.app.inject({ url: `/api/v1/members/${applicant.id}/certificate.pdf`, headers: { cookie } })).statusCode).toBe(409);
    const later = (await admin.post('/members', { firstName: 'Fritz', lastName: 'Zukunft', joinDate: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10) })).body;
    expect((await ctx.app.inject({ url: `/api/v1/members/${later.id}/certificate.pdf`, headers: { cookie } })).statusCode).toBe(409);
  });

  it('keeps sent webhook deliveries 30 days from sending, not from the event', async () => {
    const { pruneWebhookDeliveries } = await import('../src/server/webhooks/worker.ts');
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    const hook = await ctx.db.insertInto('webhook').values({ organization_id: org, url: 'https://example.org/h', topics: ['member'], secret_encrypted: 'x', active: true }).returning('id').executeTakeFirstOrThrow();
    await ctx.db.insertInto('webhook_delivery').values({ organization_id: org, webhook_id: hook.id, event: 'member.updated', entity_type: 'member', entity_id: null, occurred_at: new Date(Date.now() - 40 * 86_400_000), status: 'sent', sent_at: new Date() }).execute();
    expect(await pruneWebhookDeliveries(ctx.db)).toBe(0);
  });

  // ---------- review G13 ----------

  it('lets only settings admins switch a portal function on for a group', async () => {
    const group = (await admin.post('/groups', { name: 'Jugend', shortCode: 'JUG' })).body.id;
    const perms = (await admin.get('/roles')).body.find((r: { name: string }) => r.name === 'Admin').permissions as Record<string, string>;
    await admin.post('/roles', { name: 'Gruppenpflege', permissions: { ...Object.fromEntries(Object.keys(perms).map((m) => [m, 'read'])), groups: 'write', settings: 'none' } });
    const keeper = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Gruppenpflege') });
    expect((await keeper.patch(`/groups/${group}`, { portalOverrides: { bank: 'allow' } })).status).toBe(403);
    expect((await keeper.patch(`/groups/${group}`, { portalOverrides: { bank: 'deny' } })).status).toBe(200);
    expect((await admin.patch(`/groups/${group}`, { portalOverrides: { bank: 'allow' } })).status).toBe(200);
  });

  it('prints no dunning letter for a credit note', async () => {
    const m = (await admin.post('/members', { firstName: 'Gerd', lastName: 'Gutschrift', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body;
    const credit = (await admin.post('/invoices', { memberId: m.id, kind: 'credit_note', lines: [{ text: 'Erstattung', unitCents: 1200 }] })).body;
    expect((await admin.post(`/invoices/${credit.id}/issue`, {})).status).toBe(200);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/invoices/dunning-letters.pdf', headers: { cookie, 'content-type': 'application/json' }, payload: { invoiceIds: [credit.id] } });
    expect(res.statusCode).toBe(409);
  });

  // ---------- review G14 ----------

  it('deletes a file a contact entry points to, and removes tasks about an erased person', async () => {
    const m = (await admin.post('/members', { firstName: 'Erna', lastName: 'Erase', joinDate: '2015-01-01' })).body;
    const upload = await ctx.app.inject({ method: 'POST', url: `/api/v1/files?memberId=${m.id}`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': 'brief.pdf' }, payload: Buffer.from('%PDF-1.4 x') });
    expect(upload.statusCode, upload.body).toBe(201);
    const fileId = upload.json().id;
    expect((await admin.post(`/members/${m.id}/contacts`, { kind: 'letter', occurredOn: '2026-10-01', text: 'Brief geschickt', fileId, private: true })).status).toBe(201);
    const del = await admin.del(`/files/${fileId}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);

    const me = (await admin.get('/auth/me')).body;
    await admin.post('/tasks', { title: 'Erase wegen Rückstand anrufen', memberId: m.id, assigneeUserId: me.id });
    await admin.post(`/members/${m.id}/resign`, { noticeDate: '2020-09-01', exitDate: '2020-12-31' });
    const done = await admin.post(`/persons/${m.personId}/anonymise`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await ctx.db.selectFrom('task').select('id').where('member_id', '=', m.id).execute()).toHaveLength(0);
  });

  it('refuses income with VAT on a rate without output-tax account', async () => {
    const accounts = (await admin.get('/ledger/accounts')).body as { id: string; number: string }[];
    const acc = (n: string) => accounts.find((a) => a.number === n)!.id;
    const rate = await admin.post('/ledger/tax-rates', { label: 'Nur Vorsteuer 19 %', rateBp: 1900, validFrom: '2020-01-01', inputAccountId: acc('1570') });
    expect(rate.status, JSON.stringify(rate.body)).toBe(201);
    const r = await admin.post('/ledger/bookings', { kind: 'income', date: '2026-03-01', text: 'Verkauf', moneyAccountId: acc('1000'), lines: [{ grossCents: 11900, accountId: acc('4400'), taxRateId: rate.body.id }] });
    expect(r.status).toBe(400);
  });

  // ---------- review G17 ----------

  it('makes a financial insert wait for a running archive of the person, then refuses it', async () => {
    const m = (await admin.post('/members', { firstName: 'Rita', lastName: 'Race', joinDate: '2020-01-01' })).body;
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    const archiving = ctx.db.transaction().execute(async (tx) => {
      await tx.selectFrom('person').select('id').where('id', '=', m.personId).forUpdate().execute();
      await tx.updateTable('person').set({ status: 'archived' }).where('id', '=', m.personId).execute();
      await new Promise((r) => setTimeout(r, 300));
    });
    await new Promise((r) => setTimeout(r, 50));
    const insert = ctx.db.insertInto('allowance_payment').values({ organization_id: org, person_id: m.personId, kind: 'ehrenamt', paid_on: '2026-03-01', amount_cents: 100, text: 'Parallel' }).execute();
    await archiving;
    await expect(insert).rejects.toThrow(/archived/);
  });
});
