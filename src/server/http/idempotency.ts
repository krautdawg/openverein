import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db.ts';
import { requirePermission, type Module } from '../policy.ts';
import { Problem } from './problem.ts';

/** POST routes that create money objects: they need an `Idempotency-Key` header. */
export const MONEY_ROUTES = new Set(
  [
    '/invoices',
    '/invoices/:id/issue',
    '/invoices/:id/cancel',
    '/invoices/:id/payments',
    '/invoices/:id/write-off',
    '/invoices/:id/dunning',
    '/fee-runs/:id/post',
    '/collection-runs',
    '/bank-transactions/:id/allocate',
    '/ledger/bookings',
    '/ledger/exports/datev',
    '/donations',
    '/donation-receipts',
    '/donation-receipts/annual',
    '/receipts',
    '/receipts/self-issued',
    '/receipts/:id/pay',
    '/receipts/:id/void',
    '/work-hours/settle',
    '/expense-claims/:id/approve',
    '/bank-transactions/book',
    '/offers/:id/convert',
    '/ledger/entries/:id/reverse',
    '/donations/:id/void',
    '/bank-transactions/:id/unmatch',
    '/allowances/payments',
  ].map((r) => `/api/v1${r}`),
);
const TTL_HOURS = 24;

/** The module whose write right a money route needs (for replays, which skip the route's own checks). */
function moduleOf(route: string): Module {
  const path = route.replace('/api/v1/', '');
  if (path.startsWith('fee-runs')) return 'fees';
  if (path.startsWith('collection-runs')) return 'sepa';
  if (path.startsWith('bank-transactions')) return 'banking';
  if (path.startsWith('donation')) return 'donations';
  if (path.startsWith('ledger') || path.startsWith('receipts') || path.startsWith('expense-claims') || path.startsWith('allowances')) return 'ledger';
  return 'invoices';
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { actor: string; key: string };
  }
}

/**
 * Stores the first successful response per key for 24 hours and replays it for repeats with the same body.
 * Failed attempts free the key again, so a retry after a fixed error (or a second-factor prompt) works.
 */
export function registerIdempotency(app: FastifyInstance, db: Db) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST' || !MONEY_ROUTES.has(req.routeOptions.url ?? '') || !req.actor) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) throw new Problem(400, 'idempotency-key-required', 'Für diese Anfrage fehlt der Header Idempotency-Key.', 'Schick bei Geld-Buchungen einen eindeutigen Schlüssel (8 bis 200 Zeichen) mit; bei einer Wiederholung denselben.');
    const actor = req.actor.kind === 'user' ? req.actor.id : `token:${req.actor.id}`;
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const hash = createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex');
    const grants = createHash('sha256').update(JSON.stringify(req.actor.grants)).digest('hex');
    // An expired key is free again.
    await db.deleteFrom('idempotency_key').where('organization_id', '=', req.actor.organizationId).where('actor', '=', actor).where('key', '=', key).where('created_at', '<', sql<Date>`now() - make_interval(hours => ${TTL_HOURS})`).execute();
    const inserted = await db.insertInto('idempotency_key').values({ organization_id: req.actor.organizationId, actor, key, route, request_hash: hash, grants_hash: grants }).onConflict((oc) => oc.doNothing()).returning('key').executeTakeFirst();
    if (!inserted) {
      const prior = await db.selectFrom('idempotency_key').selectAll().where('organization_id', '=', req.actor.organizationId).where('actor', '=', actor).where('key', '=', key).executeTakeFirstOrThrow();
      if (prior.route !== route || prior.request_hash !== hash) throw new Problem(422, 'idempotency-key-reused', 'Dieser Idempotency-Key gehört zu einer anderen Anfrage.');
      if (prior.status_code === null) throw new Problem(409, 'idempotency-in-progress', 'Diese Anfrage wird gerade bearbeitet oder ihr Ergebnis ist unklar.', 'Prüfe, ob die Buchung angekommen ist, bevor Du es noch einmal versuchst; eine neue Anfrage braucht dann einen neuen Schlüssel.');
      // The stored answer was dropped by an anonymisation: the request ran, but its response is gone.
      if (prior.response === null) throw new Problem(409, 'idempotency-already-done', 'Diese Anfrage wurde schon ausgeführt.', 'Lade die Seite neu, um das Ergebnis zu sehen.');
      // A replay answers without running the route, so it cannot repeat the route's own checks (club-wide, group
      // scope, restricted fields). The stored answer goes only to unchanged rights; otherwise the caller hears that
      // the request ran, without its content, and reads the result with its rights today.
      requirePermission(req.actor, moduleOf(req.routeOptions.url ?? ''), 'write');
      if (prior.grants_hash !== grants) throw new Problem(409, 'idempotency-already-done', 'Diese Anfrage wurde schon ausgeführt.', 'Deine Rechte haben sich seitdem geändert; lade die Seite neu, um das Ergebnis zu sehen.');
      reply.header('idempotent-replayed', 'true');
      return reply.status(prior.status_code).type(prior.content_type ?? 'application/json').send(prior.response);
    }
    req.idempotency = { actor, key };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const id = req.idempotency;
    if (!id || !req.actor) return payload;
    req.idempotency = undefined;
    const q = db.updateTable('idempotency_key').where('organization_id', '=', req.actor.organizationId).where('actor', '=', id.actor).where('key', '=', id.key);
    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      if (typeof payload !== 'string' && payload !== null && payload !== undefined) req.log.warn({ route: req.routeOptions.url }, 'idempotent route sent a non-text body; replay disabled');
      else await q.set({ status_code: reply.statusCode, response: (payload as string | null) ?? '', content_type: String(reply.getHeader('content-type') ?? 'application/json') }).execute().catch((err) => req.log.error({ err }, 'idempotency result not stored; key stays pending'));
    } else if (reply.statusCode < 500) {
      // A refusal changed nothing: the key is free for the corrected retry.
      await db.deleteFrom('idempotency_key').where('organization_id', '=', req.actor.organizationId).where('actor', '=', id.actor).where('key', '=', id.key).execute();
    }
    // 5xx: the write may have committed before the failure; the key stays pending (outcome unknown) until it expires.
    return payload;
  });

}

export async function pruneIdempotencyKeys(db: Db) {
  await db.deleteFrom('idempotency_key').where('created_at', '<', sql<Date>`now() - make_interval(hours => ${TTL_HOURS})`).execute();
}
