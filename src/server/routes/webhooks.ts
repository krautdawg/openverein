import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { WEBHOOK_TOPICS } from '../../shared/webhooks.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { encrypt } from '../crypto.ts';
import { notFound, Problem } from '../http/problem.ts';
import { requireClubWide, type Actor } from '../policy.ts';
import { assertWebhookTarget } from '../webhooks/worker.ts';

const tags = ['system'];
const idParam = z.object({ id: z.uuid() });
const topics = z.array(z.enum(Object.keys(WEBHOOK_TOPICS) as [keyof typeof WEBHOOK_TOPICS])).min(1, 'Mindestens ein Thema.').max(20);
const hook = z.object({ id: z.uuid(), url: z.string(), topics: z.array(z.string()), active: z.boolean(), createdAt: z.string(), counts: z.object({ sent: z.number(), queued: z.number(), failed: z.number() }) });
const delivery = z.object({ id: z.uuid(), event: z.string(), entityType: z.string(), entityId: z.string().nullable(), occurredAt: z.string(), status: z.enum(['queued', 'sending', 'sent', 'failed']), attempts: z.number(), responseStatus: z.number().nullable(), error: z.string().nullable() });

export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  /** Webhooks reveal what changes in the club: admins of settings and API only. */
  const guard = (actor: Actor) => {
    requireClubWide(actor, 'settings', 'write');
    requireClubWide(actor, 'api', 'write');
  };
  const target = async (url: string) => {
    try {
      await assertWebhookTarget(url);
    } catch (err) {
      throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'url', message: (err as Error).message }] });
    }
  };

  async function list(organizationId: string, id?: string) {
    let q = db.selectFrom('webhook').select(['webhook.id', 'url', 'topics', 'active', 'created_at'])
      .select((eb) => [
        eb.selectFrom('webhook_delivery').select(sql<number>`count(*)::int`.as('n')).whereRef('webhook_delivery.webhook_id', '=', 'webhook.id').where('status', '=', 'sent').as('sent'),
        eb.selectFrom('webhook_delivery').select(sql<number>`count(*)::int`.as('n')).whereRef('webhook_delivery.webhook_id', '=', 'webhook.id').where('status', 'in', ['queued', 'sending']).as('queued'),
        eb.selectFrom('webhook_delivery').select(sql<number>`count(*)::int`.as('n')).whereRef('webhook_delivery.webhook_id', '=', 'webhook.id').where('status', '=', 'failed').as('failed'),
      ])
      .where('organization_id', '=', organizationId);
    if (id) q = q.where('webhook.id', '=', id);
    return (await q.orderBy('created_at').execute()).map((w) => ({ id: w.id, url: w.url, topics: w.topics, active: w.active, createdAt: w.created_at.toISOString(), counts: { sent: w.sent ?? 0, queued: w.queued ?? 0, failed: w.failed ?? 0 } }));
  }

  app.get('/webhooks', { schema: { tags, summary: 'Webhooks mit Zustellstatistik', response: { 200: z.array(hook) } } }, async (req) => {
    const actor = requireActor(req);
    guard(actor);
    return list(actor.organizationId);
  });

  app.post('/webhooks', { schema: { tags, summary: 'Webhook anlegen; das Signatur-Geheimnis wird nur jetzt angezeigt. Nutzlast: id, event, entityType, entityId, occurredAt (Details über die API); Kopfzeilen X-OpenVerein-Signature (sha256=HMAC des Zeitstempels, Punkt und Body), X-OpenVerein-Timestamp', body: z.object({ url: z.string().trim().url('Bitte eine vollständige Adresse.').max(500), topics }), response: { 201: z.object({ webhook: hook, secret: z.string() }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    guard(actor);
    await target(req.body.url);
    const secret = randomBytes(32).toString('hex');
    const id = await db.transaction().execute(async (tx) => {
      const w = await tx.insertInto('webhook').values({ organization_id: actor.organizationId, url: req.body.url, secret_encrypted: encrypt(secret), topics: req.body.topics }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'webhook.created', entityType: 'webhook', entityId: w.id, diff: { url: [null, req.body.url], topics: [null, req.body.topics] } });
      return w.id;
    });
    reply.status(201);
    return { webhook: (await list(actor.organizationId, id))[0]!, secret };
  });

  app.patch('/webhooks/:id', { schema: { tags, summary: 'Webhook ein- oder ausschalten, Themen ändern', params: idParam, body: z.object({ active: z.boolean().optional(), topics: topics.optional() }), response: { 200: hook } } }, async (req) => {
    const actor = requireActor(req);
    guard(actor);
    await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('webhook').set({ ...(req.body.active !== undefined && { active: req.body.active }), ...(req.body.topics && { topics: req.body.topics }) }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('Webhook');
      await audit(tx, actor.organizationId, actor, { action: 'webhook.updated', entityType: 'webhook', entityId: req.params.id, diff: { active: [null, req.body.active ?? null], topics: [null, req.body.topics ?? null] } });
    });
    return (await list(actor.organizationId, req.params.id))[0]!;
  });

  app.delete('/webhooks/:id', { schema: { tags, summary: 'Webhook löschen (mit seinen Zustellungen)', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    guard(actor);
    await db.transaction().execute(async (tx) => {
      const r = await tx.deleteFrom('webhook').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw notFound('Webhook');
      await audit(tx, actor.organizationId, actor, { action: 'webhook.deleted', entityType: 'webhook', entityId: req.params.id });
    });
    return reply.status(204).send();
  });

  app.get('/webhooks/:id/deliveries', { schema: { tags, summary: 'Letzte 50 Zustellungen eines Webhooks', params: idParam, response: { 200: z.array(delivery) } } }, async (req) => {
    const actor = requireActor(req);
    guard(actor);
    const rows = await db.selectFrom('webhook_delivery').selectAll().where('webhook_id', '=', req.params.id).where('organization_id', '=', actor.organizationId).orderBy('occurred_at', 'desc').limit(50).execute();
    return rows.map((d) => ({ id: d.id, event: d.event, entityType: d.entity_type, entityId: d.entity_id, occurredAt: d.occurred_at.toISOString(), status: d.status, attempts: d.attempts, responseStatus: d.response_status, error: d.error }));
  });

  app.post('/webhooks/:id/test', { schema: { tags, summary: 'Testereignis „webhook.test“ in die Warteschlange stellen', params: idParam, body: z.object({}).optional(), response: { 202: z.object({ queued: z.boolean() }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    guard(actor);
    const w = await db.selectFrom('webhook').select('id').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!w) throw notFound('Webhook');
    await db.insertInto('webhook_delivery').values({ organization_id: actor.organizationId, webhook_id: w.id, event: 'webhook.test', entity_type: 'webhook', entity_id: w.id, occurred_at: new Date() }).execute();
    reply.status(202);
    return { queued: true };
  });
};
