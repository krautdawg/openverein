import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db.ts';
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
  ].map((r) => `/api/v1${r}`),
);
const TTL_HOURS = 24;

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
    // An expired key is free again.
    await db.deleteFrom('idempotency_key').where('organization_id', '=', req.actor.organizationId).where('actor', '=', actor).where('key', '=', key).where('created_at', '<', sql<Date>`now() - make_interval(hours => ${TTL_HOURS})`).execute();
    const inserted = await db.insertInto('idempotency_key').values({ organization_id: req.actor.organizationId, actor, key, route, request_hash: hash }).onConflict((oc) => oc.doNothing()).returning('key').executeTakeFirst();
    if (!inserted) {
      const prior = await db.selectFrom('idempotency_key').selectAll().where('organization_id', '=', req.actor.organizationId).where('actor', '=', actor).where('key', '=', key).executeTakeFirstOrThrow();
      if (prior.route !== route || prior.request_hash !== hash) throw new Problem(422, 'idempotency-key-reused', 'Dieser Idempotency-Key gehört zu einer anderen Anfrage.');
      if (prior.status_code === null) throw new Problem(409, 'idempotency-in-progress', 'Diese Anfrage wird gerade schon bearbeitet.');
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
    if (reply.statusCode >= 200 && reply.statusCode < 300 && (typeof payload === 'string' || payload === null || payload === undefined)) {
      await q.set({ status_code: reply.statusCode, response: (payload as string | null) ?? '', content_type: String(reply.getHeader('content-type') ?? 'application/json') }).execute();
    } else {
      await db.deleteFrom('idempotency_key').where('organization_id', '=', req.actor.organizationId).where('actor', '=', id.actor).where('key', '=', id.key).execute();
    }
    return payload;
  });

  // A crash between preHandler and onSend would leave a pending row; it expires like the rest.
  app.addHook('onError', async (req) => {
    const id = req.idempotency;
    if (!id || !req.actor) return;
    req.idempotency = undefined;
    await db.deleteFrom('idempotency_key').where('organization_id', '=', req.actor.organizationId).where('actor', '=', id.actor).where('key', '=', id.key).execute();
  });
}

export async function pruneIdempotencyKeys(db: Db) {
  await db.deleteFrom('idempotency_key').where('created_at', '<', sql<Date>`now() - make_interval(hours => ${TTL_HOURS})`).execute();
}
