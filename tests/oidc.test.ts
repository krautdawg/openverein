import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { client, enrollTotp, reset, setupClub, testApp } from './helpers.ts';

/**
 * A minimal OpenID provider on localhost: discovery, keys and a token endpoint that signs an ID token for whatever
 * the test asks next (subject, e-mail, verification, nonce).
 */
config.oidcAllowHttp = true;
const ctx = await testApp();
let issuer = '';
let server: Server;
let next: { email: string; verified: boolean; nonce: string } = { email: '', verified: true, nonce: '' };
const keys = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const json = (v: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
    if (req.url === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    if (req.url === '/jwks') return json({ keys: [jwk] });
    if (req.url === '/token' && req.method === 'POST') {
      const idToken = await new SignJWT({ email: next.email, email_verified: next.verified, nonce: next.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('openverein').setSubject('sub-1').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
      return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await ctx.close();
});

let admin: ReturnType<typeof client>;
let adminCookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
});

/** Starts the flow like a browser, then returns from the provider with a code for `email`. */
async function signInVia(email: string, verified = true, tamperState = false) {
  const start = await ctx.app.inject({ url: '/api/v1/auth/oidc/start' });
  expect(start.statusCode, start.body).toBe(302);
  const to = new URL(String(start.headers.location));
  const flow = [start.headers['set-cookie']].flat().map(String).find((c) => c.startsWith('ov_oidc='))!.split(';')[0]!;
  next = { email, verified, nonce: to.searchParams.get('nonce')! };
  const state = tamperState ? 'falsch' : to.searchParams.get('state')!;
  return ctx.app.inject({ url: `/api/v1/auth/oidc/callback?code=abc&state=${state}`, headers: { cookie: flow } });
}

describe('sign-in through the club identity provider (OIDC)', () => {
  it('signs existing accesses in by verified e-mail and refuses everything else', async () => {
    // Setting it up needs a reachable provider and a fresh second factor (the admin has one from setup).
    expect((await admin.put('/settings/oidc', { enabled: true, issuer: 'http://127.0.0.1:1', clientId: 'openverein', clientSecret: 'geheim', label: 'Vereins-Google' })).status).toBe(400);
    const s = await admin.put('/settings/oidc', { enabled: true, issuer, clientId: 'openverein', clientSecret: 'geheim', label: 'Vereins-Google' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ enabled: true, hasSecret: true });
    expect(JSON.stringify(s.body)).not.toContain('geheim');
    expect((await ctx.app.inject({ url: '/api/v1/auth/oidc' })).json()).toEqual({ enabled: true, label: 'Vereins-Google' });

    // A user without a second factor gets a session right away.
    const invited = await admin.post('/users', { name: 'Olli Oidc', email: 'olli@example.org', grants: [{ roleId: (await admin.get('/roles')).body.find((r: { name: string }) => r.name === 'Trainer:in').id, scopeGroupIds: null }] });
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token: invited.body.inviteToken, password: 'ein-sehr-langes-passwort' } });
    const ok = await signInVia('Olli@Example.org');
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/');
    const session = [ok.headers['set-cookie']].flat().map(String).find((c) => c.startsWith('ov_session='))!.split(';')[0]!;
    expect((await ctx.app.inject({ url: '/api/v1/auth/me', headers: { cookie: session } })).json().email).toBe('olli@example.org');

    // Unknown or unverified addresses and a tampered state get nowhere.
    expect((await signInVia('fremd@example.org')).headers.location).toBe('/anmelden#fehler=unbekannt');
    expect((await signInVia('olli@example.org', false)).headers.location).toBe('/anmelden#fehler=unbekannt');
    expect((await signInVia('olli@example.org', true, true)).headers.location).toBe('/anmelden#fehler=anbieter');

    // With a second factor, the provider replaces only the password: a ticket for the code step.
    await enrollTotp(ctx.app, session);
    expect((await signInVia('olli@example.org')).headers.location).toMatch(/^\/anmelden#ticket=/);
  });

  it('is off and invisible until an admin sets it up', async () => {
    expect((await ctx.app.inject({ url: '/api/v1/auth/oidc' })).json().enabled).toBe(false);
    expect((await ctx.app.inject({ url: '/api/v1/auth/oidc/start' })).statusCode).toBe(404);
  });
});
