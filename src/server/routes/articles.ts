import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { notFound } from '../http/problem.ts';
import { requireClubWide, requirePermission } from '../policy.ts';

const tags = ['invoices'];
const input = z.object({ name: z.string().trim().min(1, 'Pflichtfeld.').max(200), unitCents: z.number().int().min(0).max(100_000_000), taxRate: z.union([z.literal(0), z.literal(7), z.literal(19)]).default(0) });
const article = input.extend({ id: z.uuid(), archived: z.boolean() });
type Row = { id: string; name: string; unit_cents: number; tax_rate: number; archived_at: Date | null };
const dto = (r: Row) => ({ id: r.id, name: r.name, unitCents: Number(r.unit_cents), taxRate: r.tax_rate as 0 | 7 | 19, archived: r.archived_at !== null });

export const articleRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/articles', { schema: { tags, summary: 'Artikel für Rechnungspositionen (ohne archivierte, außer auf Wunsch)', querystring: z.object({ includeArchived: z.stringbool().optional() }), response: { 200: z.array(article) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'read');
    let q = db.selectFrom('article').select(['id', 'name', 'unit_cents', 'tax_rate', 'archived_at']).where('organization_id', '=', actor.organizationId);
    if (!req.query.includeArchived) q = q.where('archived_at', 'is', null);
    return (await q.orderBy('name').execute()).map(dto);
  });

  app.post('/articles', { schema: { tags, summary: 'Artikel anlegen', body: input, response: { 201: article } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const r = await db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('article').values({ organization_id: actor.organizationId, name: req.body.name, unit_cents: req.body.unitCents, tax_rate: req.body.taxRate }).returning(['id', 'name', 'unit_cents', 'tax_rate', 'archived_at']).executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'article.created', entityType: 'article', entityId: r.id, diff: { name: [null, r.name], unitCents: [null, req.body.unitCents] } });
      return r;
    });
    reply.status(201);
    return dto(r);
  });

  app.put('/articles/:id', { schema: { tags, summary: 'Artikel ändern (bestehende Rechnungen behalten ihre Positionen)', params: z.object({ id: z.uuid() }), body: input.extend({ archived: z.boolean().default(false) }), response: { 200: article } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const r = await db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('article').select(['name', 'unit_cents', 'archived_at']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!before) throw notFound('Artikel');
      const r = await tx.updateTable('article').set({ name: req.body.name, unit_cents: req.body.unitCents, tax_rate: req.body.taxRate, archived_at: req.body.archived ? (before.archived_at ?? new Date()) : null }).where('id', '=', req.params.id).returning(['id', 'name', 'unit_cents', 'tax_rate', 'archived_at']).executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'article.updated', entityType: 'article', entityId: r.id, diff: { name: [before.name, r.name], unitCents: [Number(before.unit_cents), req.body.unitCents], archived: [before.archived_at !== null, req.body.archived] } });
      return r;
    });
    return dto(r);
  });
};
