import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { buildFullExport } from '../exports/full.ts';
import { getBlob, putBlob } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { requireStepUp, type Actor } from '../policy.ts';

const tags = ['system'];
const dto = z.object({ id: z.uuid(), sizeBytes: z.number(), sha256: z.string(), createdAt: z.string(), expiresAt: z.string() });

/** Only signed-in admins: the export holds everything, decrypted bank details included. */
function requireAdmin(actor: Actor) {
  if (actor.kind !== 'user' || !actor.grants.some((g) => g.builtinKey === 'admin' && g.scope === null)) throw new Problem(403, 'forbidden', 'Den Gesamtexport dürfen nur Admins starten.', undefined, { permission: 'admin' });
}

export const fullExportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  const toDto = (f: { id: string; size_bytes: number; sha256: string; created_at: Date }) => ({ id: f.id, sizeBytes: Number(f.size_bytes), sha256: f.sha256, createdAt: f.created_at.toISOString(), expiresAt: new Date(f.created_at.getTime() + 7 * 86_400_000).toISOString() });

  app.get('/exports/full', { schema: { tags, summary: 'Gesamtexporte der letzten 7 Tage', response: { 200: z.array(dto) } } }, async (req) => {
    const actor = requireActor(req);
    requireAdmin(actor);
    const rows = await db.selectFrom('file').select(['id', 'size_bytes', 'sha256', 'created_at']).where('organization_id', '=', actor.organizationId).where('purpose', '=', 'export').where('superseded_at', 'is', null).orderBy('created_at', 'desc').execute();
    return rows.map(toDto);
  });

  app.post('/exports/full', { schema: { tags, summary: 'Gesamtexport erzeugen: alle Daten des Vereins als ZIP (JSON-Lines, CSV, Dateien, manifest.json mit SHA-256); 7 Tage abrufbar', body: z.object({}).optional(), response: { 201: dto } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireAdmin(actor);
    requireStepUp(actor);
    const { file, manifest } = await buildFullExport(db, actor.organizationId);
    const sha = await putBlob(file);
    const f = await db.transaction().execute(async (tx) => {
      const f = await tx.insertInto('file').values({ organization_id: actor.organizationId, folder_id: null, member_id: null, purpose: 'export', sha256: sha, size_bytes: file.length, mime_type: 'application/zip', name: `OpenVerein-Export-${manifest.exportedAt.slice(0, 10)}.zip`, retention_class: 'temporary', retain_until: null, uploaded_by: actor.userId }).returning(['id', 'size_bytes', 'sha256', 'created_at']).executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'export.full', entityType: 'file', entityId: f.id, diff: { counts: [null, manifest.counts], sha256: [null, sha] } });
      return f;
    });
    reply.status(201);
    return toDto(f);
  });

  app.get('/exports/full/:id', { schema: { tags, summary: 'Gesamtexport herunterladen (jeder Abruf wird protokolliert)', params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireAdmin(actor);
    const f = await db.selectFrom('file').select(['id', 'sha256', 'name']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where('purpose', '=', 'export').executeTakeFirst();
    if (!f) throw notFound('Export');
    const bytes = await getBlob(f.sha256);
    await audit(db, actor.organizationId, actor, { action: 'export.full_downloaded', entityType: 'file', entityId: f.id, diff: { sha256: [null, createHash('sha256').update(bytes).digest('hex')] } });
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${f.name}"`).header('cache-control', 'private, no-store').send(bytes);
  });
};
