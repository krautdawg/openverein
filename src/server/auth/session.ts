import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppUser, Db } from '../db.ts';
import { config } from '../config.ts';
import { Problem, unauthorized } from '../http/problem.ts';
import { loadGrants, mfaRequired, type Actor } from '../policy.ts';
import { capGrants, type PersonalToken } from '../agents/tokens.ts';

export const SESSION_COOKIE = 'ov_session';
const IDLE_MS = 8 * 60 * 60 * 1000; // admin idle timeout (spec auth: 8 h)

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Inserts a session row inside the caller's transaction and returns the raw token.
 * Set the cookie only after the transaction committed (setSessionCookie).
 */
export async function insertSession(tx: Db, userId: string, userAgent?: string, mfa = false) {
  const token = randomBytes(32).toString('base64url');
  await tx
    .insertInto('session')
    .values({ token_hash: sha256(token), user_id: userId, expires_at: new Date(Date.now() + IDLE_MS), user_agent: userAgent?.slice(0, 300) ?? null, mfa_at: mfa ? new Date() : null })
    .execute();
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: IDLE_MS / 1000 });
}

export async function destroySession(db: Db, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await db.deleteFrom('session').where('token_hash', '=', sha256(token)).execute();
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolves `Authorization: Bearer ov_…` or the session cookie to an actor with its role grants. */
export async function actorFromRequest(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<Actor | null> {
  // A personal token (resolved by the agent hook) acts as its access with narrowed grants; a member token has no admin actor.
  if (req.agentToken) return req.agentToken.kind === 'admin' ? personalActor(db, req.agentToken) : null;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return tokenActor(db, auth.slice(7).trim());
  const user = await userFromCookie(db, req, reply);
  if (!user) return null;
  const grants = await loadGrants(db, user.id);
  // The demo club has one shared account without a second factor.
  const demo = config.demoMode || user.is_demo;
  const mfa = { required: !demo && mfaRequired(grants), enrolled: demo || !!user.totp_enabled_at, at: demo ? new Date() : user.mfa_at };
  return { kind: 'user', id: user.id, userId: user.id, name: user.name, organizationId: user.organization_id, grants, mfa };
}

async function personalActor(db: Db, t: PersonalToken): Promise<Actor> {
  const user = await db.selectFrom('app_user').selectAll().where('id', '=', t.user_id!).where('status', '=', 'active').executeTakeFirst();
  if (!user) throw new Problem(401, 'invalid-token', 'Das Token ist ungültig, abgelaufen oder widerrufen.');
  const grants = await loadGrants(db, user.id);
  const demo = config.demoMode || !!(await db.selectFrom('organization').select('is_demo').where('id', '=', user.organization_id).executeTakeFirst())?.is_demo;
  // No step-up ever: `at` stays empty, so actions that need a fresh second factor stay with the person.
  const mfa = { required: !demo && mfaRequired(grants), enrolled: demo || !!user.totp_enabled_at, at: null };
  return { kind: 'user', via: 'token', tokenId: t.id, id: user.id, userId: user.id, name: `${user.name} (Agent: ${t.name})`, organizationId: user.organization_id, grants: capGrants(grants, t), mfa };
}

async function tokenActor(db: Db, token: string): Promise<Actor> {
  const row = await db
    .selectFrom('api_token')
    .innerJoin('role', 'role.id', 'api_token.role_id')
    .select(['api_token.id', 'api_token.name', 'api_token.organization_id', 'api_token.scope_group_ids', 'api_token.last_used_at', 'role.id as roleId', 'role.name as roleName', 'role.permissions', 'role.restricted_fields'])
    .where('api_token.token_hash', '=', sha256(token))
    .where('api_token.revoked_at', 'is', null)
    .where('api_token.expires_at', '>', new Date())
    .executeTakeFirst();
  if (!row) throw new Problem(401, 'invalid-token', 'Der API-Schlüssel ist ungültig, abgelaufen oder widerrufen.');
  // Sampled: at most one write per token every five minutes.
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 5 * 60_000) {
    await db.updateTable('api_token').set({ last_used_at: new Date() }).where('id', '=', row.id).execute();
  }
  return {
    kind: 'token',
    id: row.id,
    userId: null,
    name: row.name,
    organizationId: row.organization_id,
    grants: [{ roleId: row.roleId, roleName: row.roleName, permissions: row.permissions, restricted: row.restricted_fields, scope: row.scope_group_ids }],
  };
}

/** Resolves the session cookie to an active user, slides the idle timeout and refreshes the cookie. */
async function userFromCookie(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<(AppUser & { mfa_at: Date | null; is_demo: boolean }) | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const hashed = sha256(token);
  const row = await db
    .selectFrom('session')
    .innerJoin('app_user', 'app_user.id', 'session.user_id')
    .selectAll('app_user')
    .innerJoin('organization', 'organization.id', 'app_user.organization_id')
    .select(['session.mfa_at', 'organization.is_demo'])
    .where('session.token_hash', '=', hashed)
    .where('session.expires_at', '>', new Date())
    .where('app_user.status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;
  await db
    .updateTable('session')
    .set({ last_seen_at: new Date(), expires_at: new Date(Date.now() + IDLE_MS) })
    .where('token_hash', '=', hashed)
    .execute();
  setSessionCookie(reply, token);
  return row;
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}
