import { createHash, timingSafeEqual } from 'node:crypto';
import { blindIndex, decryptBytes } from '../crypto.ts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { getBlob } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { isClubAdmin, requireStepUp, type Actor } from '../policy.ts';
import { jobDto, jobSchema } from './jobs.ts';

const tags = ['system'];
const dto = z.object({ id: z.uuid(), sizeBytes: z.number(), sha256: z.string(), createdAt: z.string(), expiresAt: z.string() });

/** Only signed-in admins: the export holds everything, decrypted bank details included. */
function requireAdmin(actor: Actor) {
  if (!isClubAdmin(actor)) throw new Problem(403, 'forbidden', 'Den Gesamtexport dürfen nur Admins starten.', undefined, { permission: 'admin' });
}

export const fullExportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  // Exports live 7 days: listing, link and download all refuse older ones (not only the sweep).
  const toDto = (f: { id: string; size_bytes: number; sha256: string; created_at: Date }) => ({ id: f.id, sizeBytes: Number(f.size_bytes), sha256: f.sha256, createdAt: f.created_at.toISOString(), expiresAt: new Date(f.created_at.getTime() + 7 * 86_400_000).toISOString() });

  app.get('/exports/full', { schema: { tags, summary: 'Gesamtexporte der letzten 7 Tage', response: { 200: z.array(dto) } } }, async (req) => {
    const actor = requireActor(req);
    requireAdmin(actor);
    const rows = await db.selectFrom('file').select(['id', 'size_bytes', 'sha256', 'created_at']).where('organization_id', '=', actor.organizationId).where('purpose', '=', 'export').where('superseded_at', 'is', null).where('created_at', '>', new Date(Date.now() - 7 * 86_400_000)).orderBy('created_at', 'desc').execute();
    return rows.map(toDto);
  });

  app.post('/exports/full', { schema: { tags, summary: 'Gesamtexport starten (Hintergrundaufgabe): alle Daten des Vereins als ZIP (JSON-Lines, CSV, Dateien, manifest.json mit SHA-256); danach 7 Tage abrufbar', body: z.object({}).optional(), response: { 202: jobSchema } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireAdmin(actor);
    requireStepUp(actor);
    // One at a time per club (index job_one_active): a retried request gets 409, not a second export.
    const job = await db.insertInto('job').values({ organization_id: actor.organizationId, kind: 'full_export', created_by: actor.userId, token_id: actor.tokenId ?? null }).returningAll().executeTakeFirstOrThrow();
    reply.status(202);
    return jobDto(job);
  });

  const linkSig = (id: string, userId: string, exp: number) => blindIndex(`full-export-download:${id}:${userId}:${exp}`);

  app.post('/exports/full/:id/link', { schema: { tags, summary: 'Download-Link für einen Gesamtexport (nach frischem zweiten Faktor, 60 Sekunden gültig)', params: z.object({ id: z.uuid() }), body: z.object({}).optional(), response: { 200: z.object({ url: z.string() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireAdmin(actor);
    requireStepUp(actor);
    const f = await db.selectFrom('file').select('id').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where('purpose', '=', 'export').where('created_at', '>', new Date(Date.now() - 7 * 86_400_000)).executeTakeFirst();
    if (!f) throw notFound('Export');
    const exp = Date.now() + 60_000;
    return { url: `/api/v1/exports/full/${f.id}?exp=${exp}&sig=${linkSig(f.id, actor.id, exp)}` };
  });

  app.get('/exports/full/:id', { schema: { tags, summary: 'Gesamtexport herunterladen, nur über einen frischen Download-Link (jeder Abruf wird protokolliert)', params: z.object({ id: z.uuid() }), querystring: z.object({ exp: z.coerce.number(), sig: z.string().regex(/^[0-9a-f]{64}$/) }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireAdmin(actor);
    const { exp, sig } = req.query;
    if (exp < Date.now() || !timingSafeEqual(Buffer.from(sig), Buffer.from(linkSig(req.params.id, actor.id, exp)))) throw new Problem(403, 'link-expired', 'Der Download-Link ist abgelaufen.', 'Fordere ihn neu an.');
    const f = await db.selectFrom('file').select(['id', 'sha256', 'name']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where('purpose', '=', 'export').where('created_at', '>', new Date(Date.now() - 7 * 86_400_000)).executeTakeFirst();
    if (!f) throw notFound('Export');
    const bytes = decryptBytes(await getBlob(f.sha256));
    await audit(db, actor.organizationId, actor, { action: 'export.full_downloaded', entityType: 'file', entityId: f.id, diff: { sha256: [null, createHash('sha256').update(bytes).digest('hex')] } });
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${f.name}"`).header('cache-control', 'private, no-store').send(bytes);
  });
};
