import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db, Level, PersonalTokenTable } from '../db.ts';
import { sql, type Selectable } from 'kysely';
import { sha256 } from '../auth/session.ts';
import { Problem } from '../http/problem.ts';
import { MODULES, type Grant, type Module } from '../policy.ts';

/**
 * Personal access tokens (change agent-access): an agent acts as its person, never as more.
 * `ov_pat_` = an admin access, `ov_mpt_` = a member's portal sign-in, `ov_oat_` = an OAuth grant (valid only at
 * /mcp). Club API keys keep `ov_<hex>_`. An older version rejects the new prefixes, so a rollback never widens one.
 */
export const PREFIX = { admin: 'ov_pat_', member: 'ov_mpt_', oauth: 'ov_oat_' } as const;
export const MAX_ACTIVE = 10;
export const PER_MINUTE = 120;
export const PER_HOUR = 2000;

export type PersonalToken = Selectable<PersonalTokenTable>;

declare module 'fastify' {
  interface FastifyRequest {
    agentToken?: PersonalToken;
    /** the outer /mcp request: limited, not logged; its inner calls are logged, not limited again */
    agentChannel?: 'rest' | 'mcp' | 'cli';
    agentLimited?: boolean;
  }
}

export const isPersonalToken = (raw: string) => raw.startsWith(PREFIX.admin) || raw.startsWith(PREFIX.member) || raw.startsWith(PREFIX.oauth);

export function newToken(kind: 'admin' | 'member' | 'oauth') {
  const prefix = randomBytes(4).toString('hex');
  return { prefix, token: `${PREFIX[kind]}${prefix}_${randomBytes(32).toString('base64url')}` };
}

/** The live token row; an admin token dies with its access (locked or deleted). */
export async function findToken(db: Db, raw: string) {
  const row = await db
    .selectFrom('personal_token')
    .leftJoin('app_user', 'app_user.id', 'personal_token.user_id')
    .selectAll('personal_token')
    .select('app_user.status as user_status')
    .where('personal_token.token_hash', '=', sha256(raw))
    .where('personal_token.revoked_at', 'is', null)
    .where('personal_token.expires_at', '>', new Date())
    .executeTakeFirst();
  if (!row || (row.kind === 'admin' && row.user_status !== 'active')) return null;
  // The prefix says where the token may be used; it must match the row (an OAuth grant never passes as a PAT).
  const expected = row.audience === 'mcp' ? PREFIX.oauth : PREFIX[row.kind];
  if (!raw.startsWith(expected)) return null;
  const { user_status: _, ...token } = row;
  return token as PersonalToken;
}

const rank: Record<Level, number> = { none: 0, read: 1, write: 2 };
const lower = (a: Level, b: Level): Level => (rank[a]! <= rank[b]! ? a : b);

/** The access's grants, narrowed to what the token allows (read-only, module cap). Only an unrestricted token keeps the admin role key. */
export function capGrants(grants: Grant[], t: PersonalToken): Grant[] {
  const ceiling = (m: Module): Level => lower(t.access, t.cap ? (t.cap[m] ?? 'none') : 'write');
  const full = !t.cap && t.access === 'write';
  return grants.map((g) => ({
    ...g,
    permissions: Object.fromEntries(MODULES.map((m) => [m, lower(g.permissions[m] ?? 'none', ceiling(m))])),
    builtinKey: full ? g.builtinKey : null,
  }));
}

/** Per-token limit, in memory: fail-closed when full. shortcut: per process, reset on deploy; a shared store if we run several instances. */
export function createLimiter(maxKeys = 5000) {
  const hits = new Map<string, number[]>();
  return (id: string, now = Date.now()): number | null => {
    let list = hits.get(id);
    if (!list) {
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) if (!v.length || now - v[v.length - 1]! >= 3_600_000) hits.delete(k);
        if (hits.size >= maxKeys) return 60;
      }
      list = [];
      hits.set(id, list);
    }
    while (list.length && now - list[0]! >= 3_600_000) list.shift();
    if (list.length >= PER_HOUR) return Math.max(1, Math.ceil((list[0]! + 3_600_000 - now) / 1000));
    const minuteStart = list.length - PER_MINUTE;
    if (minuteStart >= 0 && now - list[minuteStart]! < 60_000) return Math.max(1, Math.ceil((list[minuteStart]! + 60_000 - now) / 1000));
    list.push(now);
    return null;
  };
}

/** Marks in-process calls of the MCP server: only they may carry an MCP-only token, and they log as channel mcp. */
export const INTERNAL_HEADER = 'x-ov-internal';
export const internalSecret = randomUUID();

/**
 * Resolves a personal token before the actor: checks audience, read-only and the limit, and logs the call once
 * the answer is out (best effort; the audit log stays the record of writes).
 */
export function registerAgentTokens(app: FastifyInstance, db: Db) {
  const limit = createLimiter();
  app.addHook('onRequest', async (req, reply) => {
    // The route marks the outer MCP request (a path comparison would miss /mcp/ and friends).
    if ((req.routeOptions.config as { mcp?: boolean } | undefined)?.mcp) req.agentChannel = 'mcp';
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return;
    const raw = auth.slice(7).trim();
    if (!isPersonalToken(raw)) return;
    const t = await findToken(db, raw);
    if (!t) throw new Problem(401, 'invalid-token', 'Das Token ist ungültig, abgelaufen oder widerrufen.');
    const inner = req.headers[INTERNAL_HEADER] === internalSecret;
    const outerMcp = req.agentChannel === 'mcp';
    if (t.audience === 'mcp' && !inner && !outerMcp) throw new Problem(401, 'invalid-token', 'Dieses Token gilt nur für den MCP-Zugang (/mcp).');
    req.agentToken = t;
    // Counted per API call: an MCP tool call is its inner call; the outer /mcp envelope (initialize, tools/list) is not.
    if (!outerMcp) {
      const wait = limit(t.id);
      if (wait !== null) {
        reply.header('retry-after', String(wait));
        req.agentLimited = true;
        logCall(db, req, t, 429);
        throw new Problem(429, 'rate-limited', 'Zu viele Anfragen mit diesem Token.', `Wieder möglich in ${wait} Sekunden.`);
      }
    }
    if (t.access === 'read' && !['GET', 'HEAD'].includes(req.method) && !outerMcp) throw new Problem(403, 'read-only-token', 'Dieses Token darf nur lesen.');
    if (!t.last_used_at || Date.now() - t.last_used_at.getTime() > 5 * 60_000) {
      await db.updateTable('personal_token').set({ last_used_at: new Date() }).where('id', '=', t.id).execute();
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    const t = req.agentToken;
    // The agent limit logs its own 429; a route's own limit (also 429) is logged here.
    if (!t || req.agentChannel === 'mcp' || req.agentLimited) return;
    logCall(db, req, t, reply.statusCode);
  });
}

function logCall(db: Db, req: FastifyRequest, t: PersonalToken, status: number) {
  const inner = req.headers[INTERNAL_HEADER] === internalSecret;
  const channel = inner ? 'mcp' : req.headers['x-ov-channel'] === 'cli' ? 'cli' : 'rest';
  // The route pattern, never the URL: no ids or query in the log.
  const operation = `${req.method} ${(req.routeOptions.url ?? 'unbekannt').replace(/^\/api\/v1/, '')}`.slice(0, 200);
  db.insertInto('agent_call').values({ token_id: t.id, operation, channel, status }).execute().catch((err: unknown) => req.log.error(err, 'agent call log failed'));
}

export async function pruneAgentCalls(db: Db) {
  await db.deleteFrom('agent_call').where('at', '<', new Date(Date.now() - 90 * 86_400_000)).execute();
}

/** The owner's view: tokens with their last calls (the call log is the owner's, not the club's). */
export async function tokenList(db: Db, owner: { organizationId: string; userId?: string; email?: string }) {
  let q = db.selectFrom('personal_token').selectAll().where('organization_id', '=', owner.organizationId);
  q = owner.userId ? q.where('user_id', '=', owner.userId) : q.where('email', '=', owner.email!.toLowerCase());
  const tokens = await q.orderBy('created_at', 'desc').limit(50).execute();
  const ids = tokens.map((t) => t.id);
  // The last 20 calls per token and the 24-hour count, per token in SQL (a busy token must not hide the others).
  const calls = ids.length
    ? (await sql<{ token_id: string; at: Date; operation: string; channel: 'rest' | 'mcp' | 'cli'; status: number }>`
        select c.token_id, c.at, c.operation, c.channel, c.status from unnest(${ids}::uuid[]) as t(id)
        cross join lateral (select * from agent_call where token_id = t.id order by at desc limit 20) c`.execute(db)).rows
    : [];
  const counts = new Map(ids.length ? (await db.selectFrom('agent_call').select(['token_id', sql<number>`count(*)::int`.as('n')]).where('token_id', 'in', ids).where('at', '>', new Date(Date.now() - 86_400_000)).groupBy('token_id').execute()).map((r) => [r.token_id, r.n]) : []);
  return tokens.map((t) => {
    const own = calls.filter((c) => c.token_id === t.id);
    return {
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      access: t.access,
      modules: t.cap ? Object.keys(t.cap) : null,
      viaOAuth: t.audience === 'mcp',
      expiresAt: t.expires_at.toISOString(),
      lastUsedAt: t.last_used_at?.toISOString() ?? null,
      revoked: t.revoked_at !== null,
      createdAt: t.created_at.toISOString(),
      calls24h: counts.get(t.id) ?? 0,
      recentCalls: own.slice(0, 20).map((c) => ({ at: c.at.toISOString(), operation: c.operation, channel: c.channel, status: c.status })),
    };
  });
}

/** At most MAX_ACTIVE live tokens per person; counted under a lock so two requests cannot both take the last place. */
export async function assertRoom(tx: Db, owner: { organizationId: string; userId?: string; email?: string }) {
  await tx.executeQuery(sql`select pg_advisory_xact_lock(hashtext(${`pat:${owner.organizationId}:${owner.userId ?? owner.email}`}))`.compile(tx));
  let q = tx.selectFrom('personal_token').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', owner.organizationId).where('revoked_at', 'is', null).where('expires_at', '>', new Date());
  q = owner.userId ? q.where('user_id', '=', owner.userId) : q.where('email', '=', owner.email!.toLowerCase());
  if ((await q.executeTakeFirstOrThrow()).n >= MAX_ACTIVE) throw new Problem(409, 'too-many-tokens', `Höchstens ${MAX_ACTIVE} aktive Tokens.`, 'Widerrufe zuerst ein altes.');
}
