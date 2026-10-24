import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppUser, Db } from '../db.ts';
import { config } from '../config.ts';
import { unauthorized } from '../http/problem.ts';

export const SESSION_COOKIE = 'ov_session';
const IDLE_MS = 8 * 60 * 60 * 1000; // admin idle timeout (spec auth: 8 h)

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, reply: FastifyReply, userId: string, userAgent?: string) {
  const token = randomBytes(32).toString('base64url');
  await db
    .insertInto('session')
    .values({ token_hash: sha256(token), user_id: userId, expires_at: new Date(Date.now() + IDLE_MS), user_agent: userAgent?.slice(0, 300) ?? null })
    .execute();
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: IDLE_MS / 1000 });
}

export async function destroySession(db: Db, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await db.deleteFrom('session').where('token_hash', '=', sha256(token)).execute();
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolves the session cookie to an active user and slides the idle timeout. */
export async function userFromRequest(db: Db, req: FastifyRequest): Promise<AppUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const hashed = sha256(token);
  const row = await db
    .selectFrom('session')
    .innerJoin('app_user', 'app_user.id', 'session.user_id')
    .selectAll('app_user')
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
  return row;
}

export function requireUser(req: FastifyRequest): AppUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
