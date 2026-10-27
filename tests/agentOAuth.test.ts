import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { issueLoginCode } from '../src/server/routes/portal.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Change agent-access, slice 4: OAuth 2.1 for /mcp, consent in the portal (member) or the web app (admin). */
const ctx = await testApp();
afterAll(() => ctx.close());

let cookie: string;
let org: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
});

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const resource = () => `${config.publicUrl}/mcp`;
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const form = (b: Record<string, string>) => ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(b).toString() });

async function register(name = 'Claude') {
  const r = await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: name, redirect_uris: [REDIRECT] } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().client_id as string;
}

/** authorize → the consent page's query (what the browser would carry to /verbinden). */
async function authorize(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: resource(), ...extra });
  const r = await ctx.app.inject({ url: `/oauth/authorize?${q}` });
  expect(r.statusCode, r.body).toBe(302);
  expect(r.headers.location).toMatch(/^\/verbinden\?/);
  return Object.fromEntries(new URLSearchParams(String(r.headers.location).split('?')[1]));
}

async function memberCookie(email: string) {
  const code = await issueLoginCode(ctx.db, org, email, null);
  const v = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code } });
  return [v.headers['set-cookie']].flat().map(String).map((c) => c.split(';')[0]).join('; ');
}

const consent = (pc: string, query: Record<string, string>, body: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/portal/oauth/consent', headers: { cookie: pc, 'content-type': 'application/json' }, payload: { query, allow: true, access: 'read', days: 30, ...body } });

const mcp = (token: string, method: string, params: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method, params } });

describe('OAuth for MCP', () => {
  it('lets a member connect a client: metadata, registration, consent in the portal, token valid only at /mcp', async () => {
    const challengeHeader = await ctx.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: {} });
    expect(challengeHeader.headers['www-authenticate']).toBe(`Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    const prm = (await ctx.app.inject({ url: '/.well-known/oauth-protected-resource/mcp' })).json();
    expect(prm.resource).toBe(resource());
    const as = (await ctx.app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
    expect(as).toMatchObject({ issuer: config.publicUrl, code_challenge_methods_supported: ['S256'], token_endpoint: `${config.publicUrl}/oauth/token` });

    const client_admin = client(ctx.app, { cookie });
    await client_admin.post('/members', { firstName: 'Mia', lastName: 'Mitglied', email: 'mia@example.org', joinDate: '2024-01-01' });
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const query = await authorize(clientId, challenge, { scope: 'read' });
    const pc = await memberCookie('mia@example.org');
    const view = (await ctx.app.inject({ url: `/api/v1/portal/oauth/request?${new URLSearchParams(query)}`, headers: { cookie: pc } })).json();
    expect(view).toMatchObject({ clientName: 'Claude', redirectUri: REDIRECT, requestedAccess: 'read' });
    // Never more than asked for.
    expect((await consent(pc, query, { access: 'write' })).statusCode).toBe(400);
    const ok = await consent(pc, query);
    expect(ok.statusCode, ok.body).toBe(200);
    const back = new URL(ok.json().redirect);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(config.publicUrl);
    const code = back.searchParams.get('code')!;

    const tok = await form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: resource() });
    expect(tok.statusCode, tok.body).toBe(200);
    expect(tok.headers['cache-control']).toBe('no-store');
    const accessToken = tok.json().access_token as string;
    expect(accessToken.startsWith('ov_oat_')).toBe(true);
    const tools = (await mcp(accessToken, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('getPortalInvoices');
    expect((await client(ctx.app, { token: accessToken }).get('/portal/me')).status).toBe(401);
    // Revoked: /mcp still says where to sign in again.
    await ctx.db.updateTable('personal_token').set({ revoked_at: new Date() }).execute();
    const gone = await mcp(accessToken, 'tools/list');
    expect(gone.statusCode).toBe(401);
    expect(gone.headers['www-authenticate']).toMatch(/error="invalid_token", resource_metadata=/);
    // The code works once.
    expect((await form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })).json().error).toBe('invalid_grant');
  });

  it('refuses tampering, wrong PKCE, foreign redirects and parallel redemption; a denial goes back with the state', async () => {
    const admin = client(ctx.app, { cookie });
    await admin.post('/members', { firstName: 'Mia', lastName: 'Mitglied', email: 'mia@example.org', joinDate: '2024-01-01' });
    const clientId = await register();
    const { verifier, challenge } = pkce();
    // A redirect that is not registered: an error page, never a redirect (no open redirect).
    const foreign = await ctx.app.inject({ url: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })}` });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.headers.location).toBeUndefined();
    // After the redirect is confirmed, errors go back to the client (with state and issuer).
    const badType = await ctx.app.inject({ url: `/oauth/authorize?${new URLSearchParams({ response_type: 'token', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' })}` });
    expect(badType.statusCode).toBe(302);
    const err = new URL(String(badType.headers.location));
    expect([err.searchParams.get('error'), err.searchParams.get('state'), err.searchParams.get('iss')]).toEqual(['unsupported_response_type', 'st', config.publicUrl]);
    const tampered = clientId.replace(/\.[^.]+$/, '.AAAA');
    expect((await ctx.app.inject({ url: `/oauth/authorize?${new URLSearchParams({ client_id: tampered, redirect_uri: REDIRECT })}` })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'x', redirect_uris: ['http://evil.example/cb'] } })).statusCode).toBe(400);

    const query = await authorize(clientId, challenge);
    const pc = await memberCookie('mia@example.org');
    const denied = await consent(pc, query, { allow: false });
    expect(new URL(denied.json().redirect).searchParams.get('error')).toBe('access_denied');
    expect(new URL(denied.json().redirect).searchParams.get('state')).toBe('xyz');

    const fresh = async () => new URL((await consent(pc, query)).json().redirect).searchParams.get('code')!;
    // A wrong verifier or another client fails, and uses the code up.
    const c1 = await fresh();
    expect((await form({ grant_type: 'authorization_code', code: c1, client_id: clientId, redirect_uri: REDIRECT, code_verifier: pkce().verifier })).json().error).toBe('invalid_grant');
    expect((await form({ grant_type: 'authorization_code', code: c1, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })).json().error).toBe('invalid_grant');
    expect((await form({ grant_type: 'authorization_code', code: await fresh(), client_id: await register('Anderer'), redirect_uri: REDIRECT, code_verifier: verifier })).json().error).toBe('invalid_grant');
    // Newest consent wins: an older, unredeemed code is gone once the person consents again.
    const older = await fresh();
    const code = await fresh();
    expect((await form({ grant_type: 'authorization_code', code: older, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })).json().error).toBe('invalid_grant');
    // The code is opaque: no address or ids in the redirect.
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const both = await Promise.all([1, 2].map(() => form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })));
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  it('lets an admin access consent after a fresh second factor; a new consent of the same client replaces the old grant', async () => {
    const admin = client(ctx.app, { cookie });
    const run = async () => {
      const clientId = await register();
      const { verifier, challenge } = pkce();
      const query = await authorize(clientId, challenge, { scope: 'write' });
      const view = await admin.get(`/oauth/request?${new URLSearchParams(query)}`);
      expect(view.body.requestedAccess).toBe('write');
      const ok = await admin.post('/oauth/consent', { query, allow: true, access: 'read', days: 90 });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const code = new URL(ok.body.redirect).searchParams.get('code')!;
      return (await form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })).json().access_token as string;
    };
    const first = await run();
    expect((await mcp(first, 'tools/list')).statusCode).toBe(200);
    const second = await run();
    expect((await mcp(first, 'tools/list')).statusCode).toBe(401);
    expect((await mcp(second, 'tools/list')).statusCode).toBe(200);
    const tokens = (await admin.get('/personal-tokens')).body as { viaOAuth: boolean; revoked: boolean }[];
    expect(tokens.filter((t) => t.viaOAuth && !t.revoked)).toHaveLength(1);
    // A stale second factor stops the consent (as creating a token by hand).
    await ctx.db.updateTable('session').set({ mfa_at: new Date(Date.now() - 3_600_000) }).execute();
    const clientId = await register();
    const query = await authorize(clientId, pkce().challenge);
    expect((await admin.post('/oauth/consent', { query, allow: true })).body.type).toMatch(/step-up-required$/);
    void org;
  });

  it('keeps clients, codes and tokens to their own club under managed hosting', async () => {
    await reset(ctx.db);
    config.multiTenant = true;
    config.operatorToken = 'o'.repeat(40);
    try {
      const tenant = async (clubName: string, hostname: string) => {
        const t = await ctx.app.inject({ method: 'POST', url: '/api/v1/operator/tenants', headers: { 'x-operator-token': config.operatorToken }, payload: { clubName, hostname, adminName: 'Ada Admin', adminEmail: `admin@${hostname}` } });
        expect(t.statusCode, t.body).toBe(201);
        return t.json().id as string;
      };
      const a = await tenant('TSV A', 'verein-a.example.org');
      await tenant('SV B', 'verein-b.example.org');
      const at = (host: string) => ({ host });
      const reg = await ctx.app.inject({ method: 'POST', url: '/oauth/register', headers: at('verein-a.example.org'), payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
      const clientId = reg.json().client_id as string;
      const { verifier, challenge } = pkce();
      const params = (host: string) => new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: `https://${host}/mcp` });
      // A client of club A is unknown at club B.
      expect((await ctx.app.inject({ url: `/oauth/authorize?${params('verein-b.example.org')}`, headers: at('verein-b.example.org') })).statusCode).toBe(400);
      const ok = await ctx.app.inject({ url: `/oauth/authorize?${params('verein-a.example.org')}`, headers: at('verein-a.example.org') });
      expect(ok.statusCode, ok.body).toBe(302);
      const query = Object.fromEntries(new URLSearchParams(String(ok.headers.location).split('?')[1]));
      const user = (await ctx.db.selectFrom('app_user').select('id').where('organization_id', '=', a).executeTakeFirstOrThrow()).id;
      const { decide } = await import('../src/server/agents/oauth.ts');
      const fakeReq = { hostname: 'verein-a.example.org' } as never;
      const code = new URL((await decide(ctx.db, fakeReq, { org: a, kind: 'admin', sub: user, actor: null }, { query, allow: true, access: 'read', days: 30 })).redirect).searchParams.get('code')!;
      const redeem = (host: string) => ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { ...at(host), 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
      // Redeemed at club B: refused (and used up).
      expect((await redeem('verein-b.example.org')).json().error).toBe('invalid_grant');
      const code2 = new URL((await decide(ctx.db, fakeReq, { org: a, kind: 'admin', sub: user, actor: null }, { query, allow: true, access: 'read', days: 30 })).redirect).searchParams.get('code')!;
      const tok = await ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { ...at('verein-a.example.org'), 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
      expect(tok.statusCode, tok.body).toBe(200);
      const accessToken = tok.json().access_token as string;
      const call = (host: string) => ctx.app.inject({ method: 'POST', url: '/mcp', headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
      expect((await call('verein-a.example.org')).statusCode).toBe(200);
      // Club A's token at club B's host: refused, with the way to sign in there.
      const foreign = await call('verein-b.example.org');
      expect(foreign.statusCode).toBe(401);
      expect(foreign.headers['www-authenticate']).toContain('https://verein-b.example.org/.well-known/oauth-protected-resource/mcp');
    } finally {
      config.multiTenant = false;
      config.operatorToken = '';
    }
  });
});
