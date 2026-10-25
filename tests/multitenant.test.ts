import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { client, reset, testApp } from './helpers.ts';

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

const operator = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, token = TOKEN) =>
  ctx.app.inject({ method, url: `/api/v1/operator${url}`, headers: { 'x-operator-token': token }, ...(payload ? { payload: payload as object } : {}) });

/** Creates a club through the operator API and signs its admin in via the invitation. */
async function club(name: string, host: string, email: string) {
  const t = await operator('POST', '/tenants', { clubName: name, hostname: host, adminName: 'Ada Admin', adminEmail: email });
  expect(t.statusCode, t.body).toBe(201);
  expect(t.json().inviteLink).toMatch(new RegExp(`^https://${host.replaceAll('.', '\\.')}/einladung#`));
  const token = t.json().inviteLink.split('#')[1];
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token, password: 'ein-sehr-langes-passwort' } });
  expect(res.statusCode, res.body).toBe(200);
  return { id: t.json().id as string, admin: client(ctx.app, { cookie: String(res.headers['set-cookie']).split(';')[0]! }) };
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
});
