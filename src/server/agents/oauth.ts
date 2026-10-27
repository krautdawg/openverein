import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { sha256 } from '../auth/session.ts';
import { config } from '../config.ts';
import type { Db } from '../db.ts';
import { Problem } from '../http/problem.ts';
import type { Actor } from '../policy.ts';
import { baseUrlOf, tenantForRequest } from '../tenant.ts';
import { assertRoom, lockOwner, newToken } from './tokens.ts';

/**
 * OAuth 2.1 for /mcp (change agent-access, slice 4), after the KI Klub Klubraum: protected-resource and
 * authorization-server metadata (RFC 9728, 8414), stateless dynamic client registration (RFC 7591), PKCE S256,
 * `resource` (RFC 8707). The client_id is an HMAC-signed blob bound to its issuer (host). Codes are random and live in
 * oauth_code (hash only): redeeming deletes the row in the grant's transaction. A grant is a personal token with
 * audience `mcp` (`ov_oat_`): valid only at /mcp, and only at its club's host.
 * The person consents in the web app (admin access, after its login and a fresh second factor) or the portal (member).
 */
const CODE_TTL_MS = 5 * 60 * 1000;
export const GRANT_DAYS = [30, 90] as const;
export const ACCESS_SCOPES = ['read', 'write'] as const;

const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest('base64url');
/** One key per purpose, derived from the data key: a leaked client id key cannot mint codes. */
const keyFor = (purpose: string) => hmac(config.dataKey, `openverein-oauth:${purpose}`);

export function sign(kind: 'ovc', payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${kind}.${body}.${hmac(keyFor(kind), `${kind}.${body}`)}`;
}

export function verify<T>(kind: 'ovc', token: string | undefined): T | null {
  if (!token || token.length > 5000) return null;
  const [k, body, sig] = token.split('.');
  if (k !== kind || !body || !sig) return null;
  const want = Buffer.from(hmac(keyFor(kind), `${kind}.${body}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** A registered client: name, redirect URIs, issuer (the host that registered it), issue time, randomness. */
export interface ClientData { n: string; r: string[]; i: string; t: number; j: string }
/** "The same client" for replacing a grant: name and redirect URIs, not the client_id (new on every registration). */
export const fingerprint = (c: ClientData) => createHash('sha256').update(JSON.stringify([c.n, [...c.r].sort()])).digest('hex');

/** https, or http on localhost; no fragment, no credentials, no OAuth answer parameters. */
export function redirectAllowed(uri: string) {
  if (uri.length > 500) return false;
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    for (const p of ['code', 'state', 'error', 'error_description', 'error_uri', 'iss']) if (u.searchParams.has(p)) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

export interface AuthRequest { clientId: string; client: ClientData; redirectUri: string; state?: string; codeChallenge: string; access: 'read' | 'write' | null; resource: string }
type Checked = { ok: true; request: AuthRequest } | { ok: false; error: string; description: string; redirectUri?: string; state?: string };

/** Checks an authorization request; errors before the redirect URI is confirmed never redirect (open redirect). */
export function checkRequest(q: Record<string, unknown>, resource: string): Checked {
  const text = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
  const clientId = text('client_id');
  const client = verify<ClientData>('ovc', clientId);
  // A client belongs to the authorization server (host) that registered it.
  if (!clientId || !client || `${client.i}/mcp` !== resource) return { ok: false, error: 'invalid_client', description: 'Unbekannter oder ungültiger Client.' };
  const redirectUri = text('redirect_uri');
  if (!redirectUri || !client.r.includes(redirectUri)) return { ok: false, error: 'invalid_request', description: 'Die redirect_uri ist für diesen Client nicht registriert.' };
  const state = text('state');
  if (state !== undefined && state.length > 500) return { ok: false, error: 'invalid_request', description: 'state ist zu lang (höchstens 500 Zeichen).' };
  const fail = (error: string, description: string) => ({ ok: false as const, error, description, redirectUri, state });
  if (text('response_type') !== 'code') return fail('unsupported_response_type', 'Nur response_type=code.');
  const codeChallenge = text('code_challenge');
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || text('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE mit code_challenge_method=S256 ist Pflicht.');
  const res = text('resource');
  if (res !== undefined && res.replace(/\/$/, '') !== resource) return fail('invalid_target', `resource muss ${resource} sein.`);
  const scopes = (text('scope') ?? '').split(/\s+/).filter(Boolean);
  const unknown = scopes.filter((s) => !(ACCESS_SCOPES as readonly string[]).includes(s));
  if (unknown.length) return fail('invalid_scope', `Nicht verfügbar: ${unknown.join(', ')}.`);
  const access = scopes.includes('write') ? 'write' : scopes.includes('read') ? 'read' : null;
  return { ok: true, request: { clientId, client, redirectUri, state, codeChallenge, access, resource } };
}

export function withParams(uri: string, params: Record<string, string | undefined>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** What the person allowed, stored with the code's hash. */
export interface CodeData { cid: string; fp: string; r: string; ch: string; org: string; kind: 'admin' | 'member'; sub: string; a: 'read' | 'write'; d: number; res: string }

export function pkceOk(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The club of this host and its addresses: OAuth is per instance host (each club's own host under managed hosting). */
export async function hostBase(db: Db, req: FastifyRequest) {
  const org = await tenantForRequest(db, req);
  const base = baseUrlOf(org);
  return { org, base, resource: `${base}/mcp` };
}

export const consentInput = z.object({
  query: z.record(z.string(), z.string()),
  allow: z.boolean(),
  access: z.enum(ACCESS_SCOPES).default('read'),
  days: z.union([z.literal(30), z.literal(90)]).default(30),
});

/** What the consent page shows: checked again by the server, so the page never shows what it would not grant. */
export function consentView(r: AuthRequest) {
  return { clientName: r.client.n, redirectUri: r.redirectUri, requestedAccess: r.access, days: [...GRANT_DAYS] as number[] };
}

/** The person's decision: a code bound to client, redirect, PKCE challenge, owner, access and lifetime, or a refusal. */
export async function decide(db: Db, req: FastifyRequest, owner: { org: string; kind: 'admin' | 'member'; sub: string; actor: Actor | null }, body: z.infer<typeof consentInput>) {
  const { org, resource, base } = await hostBase(db, req);
  if (!org || org.id !== owner.org) throw new Problem(400, 'oauth-host', 'Diese Anfrage gehört zu einem anderen Verein.');
  const c = checkRequest(body.query, resource);
  if (!c.ok) throw new Problem(400, 'oauth-request', c.description);
  const r = c.request;
  if (!body.allow) return { redirect: withParams(r.redirectUri, { error: 'access_denied', state: r.state, iss: base }) };
  // Never more than the client asked for.
  if (r.access === 'read' && body.access === 'write') throw new Problem(400, 'oauth-access', 'Der Client hat nur Lesen angefragt.');
  const code = randomBytes(32).toString('base64url');
  const fp = fingerprint(r.client);
  const payload: CodeData = { cid: sha256(r.clientId), fp, r: r.redirectUri, ch: r.codeChallenge, org: owner.org, kind: owner.kind, sub: owner.sub, a: body.access, d: body.days, res: r.resource };
  await db.transaction().execute(async (tx) => {
    // Newest consent wins: older codes of this person for this client cannot be redeemed any more.
    await tx.deleteFrom('oauth_code').where('organization_id', '=', owner.org).where('owner_key', '=', `${owner.kind}:${owner.sub}`).where('client_fingerprint', '=', fp).execute();
    await tx.insertInto('oauth_code').values({ code_hash: sha256(code), organization_id: owner.org, owner_key: `${owner.kind}:${owner.sub}`, client_fingerprint: fp, payload: JSON.stringify(payload), expires_at: new Date(Date.now() + CODE_TTL_MS) }).execute();
  });
  await audit(db, owner.org, owner.actor, { action: 'oauth.consented', entityType: 'oauth_client', entityId: fingerprint(r.client).slice(0, 16), diff: { client: [null, r.client.n], access: [null, body.access], portal: [null, owner.kind === 'member'] } });
  return { redirect: withParams(r.redirectUri, { code, state: r.state, iss: base }) };
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.status(status).header('cache-control', 'no-store').send({ error, error_description: description });
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const errorPage = (title: string, text: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#14202e;line-height:1.55"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;

/** Per-IP counters for the public endpoints (registration, token). shortcut: in memory, per process. */
function ipLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (ip: string) => {
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (hits.size > 10_000) hits.clear();
    list.push(now);
    hits.set(ip, list);
    return list.length <= max;
  };
}

export async function registerOAuth(app: FastifyInstance, db: Db) {
  const cors = async (req: FastifyRequest, reply: FastifyReply) => {
    // No credentials: only so browser-based clients (MCP Inspector) reach the public endpoints.
    reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'Content-Type, Authorization, MCP-Protocol-Version').header('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return reply.status(204).send();
  };
  const hidden = { schema: { hide: true }, onRequest: cors };

  const resourceMetadata = async (req: FastifyRequest) => {
    const { base, resource } = await hostBase(db, req);
    return { resource, authorization_servers: [base], scopes_supported: ACCESS_SCOPES, bearer_methods_supported: ['header'], resource_name: 'OpenVerein', resource_documentation: `${base}/api/docs` };
  };
  app.get('/.well-known/oauth-protected-resource', hidden, resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', hidden, resourceMetadata);
  app.get('/.well-known/oauth-authorization-server', hidden, async (req) => {
    const { base } = await hostBase(db, req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ACCESS_SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
  });

  const registerLimit = ipLimit(20, 3_600_000);
  const registration = z.object({ client_name: z.string().trim().min(1).max(80).optional(), redirect_uris: z.array(z.string()).min(1).max(5), token_endpoint_auth_method: z.string().optional() }).loose();
  app.options('/oauth/register', hidden, async () => undefined);
  app.post('/oauth/register', { ...hidden, bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (!registerLimit(req.ip)) return oauthError(reply, 429, 'slow_down', 'Zu viele Registrierungen. Bitte später erneut.');
    const p = registration.safeParse(req.body);
    if (!p.success) return oauthError(reply, 400, 'invalid_client_metadata', 'client_name (höchstens 80 Zeichen) und 1 bis 5 redirect_uris sind nötig.');
    if (p.data.token_endpoint_auth_method && p.data.token_endpoint_auth_method !== 'none') return oauthError(reply, 400, 'invalid_client_metadata', 'Nur öffentliche Clients (token_endpoint_auth_method=none, PKCE).');
    if (!p.data.redirect_uris.every(redirectAllowed)) return oauthError(reply, 400, 'invalid_redirect_uri', 'redirect_uris müssen https sein (oder http auf localhost).');
    const { base, org } = await hostBase(db, req);
    if (!org) return oauthError(reply, 404, 'invalid_request', 'Unbekannter Verein.');
    // Stored as the URL parser reads them, so what is checked, shown and redirected to is the same string.
    const client: ClientData = { n: p.data.client_name ?? 'Unbenannter Client', r: p.data.redirect_uris.map((u) => new URL(u).href), i: base, t: Math.floor(Date.now() / 1000), j: randomBytes(8).toString('base64url') };
    return reply.status(201).header('cache-control', 'no-store').send({ client_id: sign('ovc', client), client_id_issued_at: client.t, client_name: client.n, redirect_uris: client.r, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] });
  });

  app.get('/oauth/authorize', { schema: { hide: true } }, async (req, reply) => {
    const { resource, base, org } = await hostBase(db, req);
    if (!org) return reply.status(404).type('text/html').send(errorPage('Verbindung nicht möglich', 'Unbekannter Verein.'));
    const c = checkRequest(req.query as Record<string, unknown>, resource);
    // After the redirect is confirmed the client hears the error; before, only a page (no open redirect).
    if (!c.ok && c.redirectUri) return reply.redirect(withParams(c.redirectUri, { error: c.error, error_description: c.description, state: c.state, iss: base }), 302);
    if (!c.ok) return reply.status(400).type('text/html').send(errorPage('Verbindung nicht möglich', `${escapeHtml(c.description)} Starte die Verbindung bitte noch einmal in Deinem KI-Client.`));
    // The consent page gets only the checked parameters and checks them again.
    const r = c.request;
    const q = new URLSearchParams({ response_type: 'code', client_id: r.clientId, redirect_uri: r.redirectUri, code_challenge: r.codeChallenge, code_challenge_method: 'S256', resource: r.resource, ...(r.access ? { scope: r.access } : {}), ...(r.state !== undefined ? { state: r.state } : {}) });
    return reply.redirect(`/verbinden?${q}`, 302);
  });

  const tokenLimit = ipLimit(60, 3_600_000);
  // Form-encoded, as RFC 6749 wants; parsed only here (8 kB).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8 * 1024 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    scope.options('/oauth/token', hidden, async () => undefined);
    scope.post('/oauth/token', hidden, async (req, reply) => {
      if (!tokenLimit(req.ip)) return oauthError(reply, 429, 'slow_down', 'Zu viele Anfragen. Bitte später erneut.');
      if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return oauthError(reply, 415, 'invalid_request', 'Bitte als application/x-www-form-urlencoded.');
      const b = (req.body ?? {}) as Record<string, string>;
      if (b.grant_type !== 'authorization_code') return oauthError(reply, 400, 'unsupported_grant_type', 'Nur grant_type=authorization_code.');
      const client = verify<ClientData>('ovc', b.client_id);
      if (!client) return oauthError(reply, 401, 'invalid_client', 'Unbekannter oder ungültiger Client.');
      const invalid = () => oauthError(reply, 400, 'invalid_grant', 'Der Code ist ungültig, abgelaufen oder schon benutzt.');
      if (!b.code) return invalid();
      const now = Date.now();
      const { org } = await hostBase(db, req);
      const { prefix, token } = newToken('oauth');
      const issued = await db.transaction().execute(async (tx) => {
        // Taking the code deletes it: one redemption, also across instances; a failed attempt uses it up too.
        const row = await tx.deleteFrom('oauth_code').where('code_hash', '=', sha256(b.code!)).where('expires_at', '>', new Date()).returning('payload').executeTakeFirst();
        const code = row?.payload as CodeData | undefined;
        if (!code || code.cid !== sha256(b.client_id!) || code.r !== b.redirect_uri || code.org !== org?.id) return 'invalid' as const;
        if (b.resource !== undefined && b.resource.replace(/\/$/, '') !== code.res) return 'target' as const;
        if (!b.code_verifier || !pkceOk(b.code_verifier, code.ch)) return 'invalid' as const;
        const owner = code.kind === 'admin' ? { organizationId: code.org, userId: code.sub } : { organizationId: code.org, email: code.sub };
        if (code.kind === 'admin') {
          const user = await tx.selectFrom('app_user').select('status').where('id', '=', code.sub).where('organization_id', '=', code.org).executeTakeFirst();
          if (user?.status !== 'active') return 'invalid' as const;
        }
        // Lock first, then replace: two redemptions for the same person cannot both miss each other's grant.
        await lockOwner(tx, owner);
        let old = tx.updateTable('personal_token').set({ revoked_at: new Date() }).where('organization_id', '=', code.org).where('oauth_client', '=', code.fp).where('revoked_at', 'is', null);
        old = code.kind === 'admin' ? old.where('user_id', '=', code.sub) : old.where('email', '=', code.sub);
        for (const r of await old.returning('id').execute()) await audit(tx, code.org, null, { action: 'personal_token.revoked', entityType: 'personal_token', entityId: r.id, diff: { replacedByNewConsent: [null, true] } });
        await assertRoom(tx, owner);
        const expires = new Date(now + code.d * 86_400_000);
        const t = await tx.insertInto('personal_token').values({ organization_id: code.org, kind: code.kind, user_id: code.kind === 'admin' ? code.sub : null, email: code.kind === 'member' ? code.sub : null, name: `${client.n} (OAuth)`.slice(0, 80), prefix, token_hash: sha256(token), access: code.a, audience: 'mcp', oauth_client: code.fp, expires_at: expires }).returning('id').executeTakeFirstOrThrow();
        await audit(tx, code.org, null, { action: 'personal_token.created', entityType: 'personal_token', entityId: t.id, diff: { access: [null, code.a], oauth: [null, true] } });
        return { expires, access: code.a };
      }).catch((err: unknown) => (err instanceof Problem && err.type.endsWith('/too-many-tokens') ? ('limit' as const) : Promise.reject(err)));
      if (issued === 'invalid') return invalid();
      if (issued === 'target') return oauthError(reply, 400, 'invalid_target', 'resource passt nicht zur Autorisierung.');
      if (issued === 'limit') return oauthError(reply, 400, 'invalid_grant', 'Es gibt schon zehn aktive Tokens. Widerrufe eines unter Agenten.');
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({ access_token: token, token_type: 'Bearer', expires_in: Math.floor((issued.expires.getTime() - now) / 1000), scope: issued.access });
    });
  });
}

export async function pruneOAuthCodes(db: Db) {
  await db.deleteFrom('oauth_code').where('expires_at', '<', new Date()).execute();
}
