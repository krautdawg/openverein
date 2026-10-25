import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { client, enrollTotp, reset, testApp } from './helpers.ts';

const ctx = await testApp();
const TOKEN = 'o'.repeat(40);
afterAll(() => {
  config.multiTenant = false;
  config.operatorToken = '';
  return ctx.close();
});
beforeEach(async () => {
  await reset(ctx.db);
  config.multiTenant = true;
  config.operatorToken = TOKEN;
});

const operator = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token = TOKEN) =>
  ctx.app.inject({ method, url: `/api/v1/operator${url}`, headers: { 'x-operator-token': token }, ...(payload ? { payload: payload as object } : {}) });

/** Creates a club through the operator API and signs its admin in via the invitation. */
async function club(name: string, host: string, email: string) {
  const t = await operator('POST', '/tenants', { clubName: name, hostname: host, adminName: 'Ada Admin', adminEmail: email });
  expect(t.statusCode, t.body).toBe(201);
  expect(t.json().inviteLink).toMatch(new RegExp(`^https://${host.replaceAll('.', '\\.')}/einladung#`));
  const token = t.json().inviteLink.split('#')[1];
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token, password: 'ein-sehr-langes-passwort' } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { id: t.json().id as string, cookie, admin: client(ctx.app, { cookie }) };
}

describe('managed hosting (several clubs)', () => {
  it('provisions clubs through the operator, keeps them apart, and routes the portal by host name', async () => {
    expect((await operator('GET', '/tenants', undefined, 'falsch')).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { clubName: 'TSV Musterstadt 1890 e.V.', name: 'Erika Mustermann', email: 'x@example.org', password: 'korrekt-pferd-batterie' } })).statusCode).toBe(403);
    const a = await club('TSV A', 'verein-a.example.org', 'admin-a@example.org');
    const b = await club('SV B', 'verein-b.example.org', 'admin-b@example.org');
    expect((await operator('POST', '/tenants', { clubName: 'Dritt', hostname: 'verein-a.example.org', adminName: 'X Y', adminEmail: 'c@example.org' })).statusCode).toBe(409);
    expect((await operator('GET', '/tenants')).json().map((t: { hostname: string }) => t.hostname)).toEqual(['verein-a.example.org', 'verein-b.example.org']);

    // An access signs in only on its own club's host name.
    const login = (host: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host }, payload: { email: 'admin-a@example.org', password: 'ein-sehr-langes-passwort' } });
    expect((await login('verein-b.example.org')).statusCode).toBe(401);
    expect((await login('verein-a.example.org')).statusCode).toBe(200);

    const bert = (await b.admin.post('/members', { firstName: 'Bert', lastName: 'Beta', email: 'bert@example.org', joinDate: '2024-01-01' })).body.id;
    await a.admin.post('/members', { firstName: 'Anna', lastName: 'Alpha', email: 'anna@example.org', joinDate: '2024-01-01' });
    // Club A sees nothing of club B.
    expect((await a.admin.get(`/members/${bert}`)).status).toBe(404);
    expect((await a.admin.get('/members')).body.items.map((m: { lastName: string }) => m.lastName)).toEqual(['Alpha']);

    // The portal issues a code only in the club of the host name the request came in on.
    const ask = (host: string, email: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/request-code', headers: { host }, payload: { email } });
    await ask('verein-a.example.org', 'bert@example.org');
    await ask('verein-b.example.org', 'bert@example.org');
    await new Promise((r) => setTimeout(r, 200));
    const codes = await ctx.db.selectFrom('login_code').select('organization_id').execute();
    expect(codes.map((c) => c.organization_id)).toEqual([b.id]);
    expect((await ask('unbekannt.example.org', 'bert@example.org')).statusCode).toBe(200);
  });

  it('hands a leaving club its export and then deletes it completely, leaving the other club untouched', async () => {
    const a = await club('TSV A', 'verein-a.example.org', 'admin-a@example.org');
    const b = await club('SV B', 'verein-b.example.org', 'admin-b@example.org');
    for (const c of [a, b]) {
      await enrollTotp(ctx.app, c.cookie);
      await c.admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
      const m = (await c.admin.post('/members', { firstName: 'Anna', lastName: 'Alpha', email: 'anna@example.org', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body;
      const created = await c.admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 6000 }] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const inv = created.body;
      const issued = await c.admin.post(`/invoices/${inv.id}/issue`, {});
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      await c.admin.post(`/invoices/${inv.id}/payments`, { amountCents: 6000, bookedOn: '2026-01-05', method: 'cash' });
    }
    const count = async (table: string, org: string) => Number((await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${org}`.execute(ctx.db)).rows[0]!.n);
    const bBefore = { invoice: await count('invoice', b.id), journal: await count('journal_entry', b.id), audit: await count('audit_event', b.id) };

    const zip = await operator('GET', `/tenants/${a.id}/export.zip`);
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-disposition']).toContain('openverein-verein-a.example.org.zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');

    expect((await operator('DELETE', `/tenants/${a.id}`, { confirmHostname: 'verein-b.example.org' })).statusCode).toBe(400);
    const gone = await operator('DELETE', `/tenants/${a.id}`, { confirmHostname: 'Verein-A.example.org' });
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json().deleted).toMatchObject({ organization: 1, invoice: 1, member: 1 });
    for (const t of ['invoice', 'journal_entry', 'member', 'person', 'app_user', 'audit_event']) expect(await count(t, a.id)).toBe(0);
    expect((await operator('GET', '/tenants')).json().map((t: { hostname: string }) => t.hostname)).toEqual(['verein-b.example.org']);
    expect({ invoice: await count('invoice', b.id), journal: await count('journal_entry', b.id), audit: await count('audit_event', b.id) }).toEqual(bBefore);
    // The remaining club works as before, and the deleted host name signs nobody in.
    expect((await b.admin.get('/members')).body.items).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: 'verein-a.example.org' }, payload: { email: 'admin-a@example.org', password: 'ein-sehr-langes-passwort' } })).statusCode).toBe(401);
    expect((await operator('DELETE', `/tenants/${a.id}`, { confirmHostname: 'verein-a.example.org' })).statusCode).toBe(404);
  });
});
