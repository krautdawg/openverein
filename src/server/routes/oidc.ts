import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as client from 'openid-client';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { insertSession, requireActor, setSessionCookie } from '../auth/session.ts';
import { config } from '../config.ts';
import { decrypt, encrypt } from '../crypto.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { isClubAdmin, requireStepUp } from '../policy.ts';
import { baseUrlOf, tenantForRequest } from '../tenant.ts';
import { ticketFor, userActor } from './auth.ts';

const tags = ['auth'];
const COOKIE = 'ov_oidc';
const FLOW_MS = 10 * 60_000;
const settingsDto = z.object({ enabled: z.boolean(), issuer: z.string().nullable(), clientId: z.string().nullable(), label: z.string().nullable(), hasSecret: z.boolean(), redirectUri: z.string() });

/** The flow cookie (PKCE verifier, state, nonce) is signed, so it cannot be forged or swapped between clubs. */
const sign = (payload: string) => createHmac('sha256', `oidc-flow:${config.dataKey}`).update(payload).digest('base64url');
function packFlow(v: { org: string; verifier: string; state: string; nonce: string }) {
  const payload = Buffer.from(JSON.stringify({ ...v, exp: Date.now() + FLOW_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function unpackFlow(raw: string | undefined) {
  const [payload, mac] = (raw ?? '').split('.');
  if (!payload || !mac || mac.length !== sign(payload).length || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(payload)))) return null;
  const v = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { org: string; verifier: string; state: string; nonce: string; exp: number };
  return v.exp > Date.now() ? v : null;
}

async function clientConfig(db: Db, orgId: string) {
  const o = await db.selectFrom('organization').select(['oidc_enabled', 'oidc_issuer', 'oidc_client_id', 'oidc_client_secret_encrypted', 'hostname']).where('id', '=', orgId).executeTakeFirst();
  if (!o?.oidc_enabled || !o.oidc_issuer || !o.oidc_client_id || !o.oidc_client_secret_encrypted) return null;
  const insecure = config.oidcAllowHttp && o.oidc_issuer.startsWith('http://');
  const cfg = await client.discovery(new URL(o.oidc_issuer), o.oidc_client_id, decrypt(o.oidc_client_secret_encrypted), undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined);
  return { cfg, redirectUri: `${baseUrlOf(o)}/api/v1/auth/oidc/callback` };
}

/**
 * Sign-in through the club's identity provider (roadmap P3.10), e.g. Google Workspace, Microsoft or Nextcloud.
 * Only accesses that already exist and are active sign in this way (matched by the provider's verified e-mail);
 * a second factor required for finance roles is still asked for afterwards.
 */
export const oidcRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/auth/oidc', { schema: { tags, summary: 'Ob die Anmeldung über das Vereins-Konto (OIDC) eingerichtet ist', security: [], response: { 200: z.object({ enabled: z.boolean(), label: z.string() }) } } }, async (req) => {
    const t = await tenantForRequest(db, req);
    const o = t ? await db.selectFrom('organization').select(['oidc_enabled', 'oidc_label']).where('id', '=', t.id).executeTakeFirst() : undefined;
    return { enabled: !!o?.oidc_enabled, label: o?.oidc_label || 'Vereins-Konto' };
  });

  app.get('/auth/oidc/start', { schema: { tags, summary: 'Anmeldung beim Identitätsanbieter beginnen (Weiterleitung)', security: [] } }, async (req, reply) => {
    const t = await tenantForRequest(db, req);
    const c = t ? await clientConfig(db, t.id) : null;
    if (!t || !c) throw notFound('Anmeldung über das Vereins-Konto');
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(c.cfg, { redirect_uri: c.redirectUri, scope: 'openid email profile', code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
    reply.setCookie(COOKIE, packFlow({ org: t.id, verifier, state, nonce }), { path: '/api/v1/auth/oidc', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: FLOW_MS / 1000 });
    return reply.redirect(url.href);
  });

  app.get('/auth/oidc/callback', { schema: { tags, summary: 'Rückkehr vom Identitätsanbieter', security: [] } }, async (req, reply) => {
    const back = (reason: string) => reply.clearCookie(COOKIE, { path: '/api/v1/auth/oidc' }).redirect(`/anmelden#fehler=${reason}`);
    const flow = unpackFlow(req.cookies[COOKIE]);
    if (!flow) return back('abgelaufen');
    const c = await clientConfig(db, flow.org);
    if (!c) return back('nicht-eingerichtet');
    let claims: client.IDToken | undefined;
    try {
      const current = new URL(`${c.redirectUri}${req.url.slice(req.url.indexOf('?'))}`);
      const tokens = await client.authorizationCodeGrant(c.cfg, current, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      claims = tokens.claims();
    } catch (err) {
      req.log.warn({ err }, 'OIDC sign-in failed');
      return back('anbieter');
    }
    // Only a verified address may map to an access of this club.
    const email = typeof claims?.email === 'string' && claims.email_verified === true ? claims.email.toLowerCase() : null;
    const user = email ? await db.selectFrom('app_user').selectAll().where('organization_id', '=', flow.org).where(sql<boolean>`lower(email) = ${email}`).where('status', '=', 'active').executeTakeFirst() : undefined;
    if (!user) {
      await audit(db, flow.org, null, { action: 'auth.oidc_refused', entityType: 'organization', entityId: flow.org });
      return back('unbekannt');
    }
    reply.clearCookie(COOKIE, { path: '/api/v1/auth/oidc' });
    // With a second factor, the provider sign-in replaces only the password; the code is still asked for.
    if (user.totp_enabled_at && !config.demoMode) return reply.redirect(`/anmelden#ticket=${encodeURIComponent(ticketFor(user.id))}`);
    const token = await db.transaction().execute(async (tx) => {
      await tx.updateTable('app_user').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
      await audit(tx, user.organization_id, userActor(user), { action: 'auth.login_oidc', entityType: 'app_user', entityId: user.id });
      return insertSession(tx, user.id, req.headers['user-agent']);
    });
    setSessionCookie(reply, token);
    return reply.redirect('/');
  });

  // ---------- Settings ----------

  const settingsOf = async (orgId: string) => {
    const o = await db.selectFrom('organization').select(['oidc_enabled', 'oidc_issuer', 'oidc_client_id', 'oidc_label', 'oidc_client_secret_encrypted', 'hostname']).where('id', '=', orgId).executeTakeFirstOrThrow();
    return { enabled: o.oidc_enabled, issuer: o.oidc_issuer, clientId: o.oidc_client_id, label: o.oidc_label, hasSecret: !!o.oidc_client_secret_encrypted, redirectUri: `${baseUrlOf(o)}/api/v1/auth/oidc/callback` };
  };

  app.get('/settings/oidc', { schema: { tags, summary: 'Einstellungen der Anmeldung über das Vereins-Konto (ohne Geheimnis)', response: { 200: settingsDto } } }, async (req) => {
    const actor = requireActor(req);
    if (!isClubAdmin(actor)) throw new Problem(403, 'forbidden', 'Das richten nur Admins ein.', undefined, { permission: 'admin' });
    return settingsOf(actor.organizationId);
  });

  app.put('/settings/oidc', { schema: { tags, summary: 'Anmeldung über das Vereins-Konto einrichten (Issuer, Client-ID, Client-Secret)', body: z.object({ enabled: z.boolean(), issuer: z.url().max(300).nullable(), clientId: z.string().trim().max(300).nullable(), clientSecret: z.string().max(500).optional(), label: z.string().trim().max(60).nullable() }), response: { 200: settingsDto } } }, async (req) => {
    const actor = requireActor(req);
    if (!isClubAdmin(actor)) throw new Problem(403, 'forbidden', 'Das richten nur Admins ein.', undefined, { permission: 'admin' });
    requireStepUp(actor);
    const b = req.body;
    if (b.issuer && !b.issuer.startsWith('https://') && !config.oidcAllowHttp) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'issuer', message: 'Der Issuer muss mit https:// beginnen.' }] });
    const current = await settingsOf(actor.organizationId);
    if (b.enabled && (!b.issuer || !b.clientId || !(b.clientSecret || current.hasSecret))) throw new Problem(400, 'validation', 'Zum Einschalten braucht es Issuer, Client-ID und Client-Secret.');
    // Check the provider before switching on: a wrong issuer must not lock anyone out silently.
    if (b.enabled && b.issuer) {
      try {
        const insecure = config.oidcAllowHttp && b.issuer.startsWith('http://');
        await client.discovery(new URL(b.issuer), b.clientId!, b.clientSecret ?? 'x', undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined);
      } catch {
        throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'issuer', message: 'Unter diesem Issuer ist keine OpenID-Konfiguration erreichbar.' }] });
      }
    }
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('organization').set({ oidc_enabled: b.enabled, oidc_issuer: b.issuer, oidc_client_id: b.clientId, oidc_label: b.label, ...(b.clientSecret ? { oidc_client_secret_encrypted: encrypt(b.clientSecret) } : {}), updated_at: new Date() }).where('id', '=', actor.organizationId).execute();
      await audit(tx, actor.organizationId, actor, { action: 'settings.oidc', entityType: 'organization', entityId: actor.organizationId, diff: { enabled: [current.enabled, b.enabled], issuer: [current.issuer, b.issuer], clientId: [current.clientId, b.clientId], secret: [null, b.clientSecret ? 'geändert' : null] } });
    });
    return settingsOf(actor.organizationId);
  });
};
