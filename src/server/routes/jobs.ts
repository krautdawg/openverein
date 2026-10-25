import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireActor } from '../auth/session.ts';
import type { JobKind } from '../db.ts';
import { notFound } from '../http/problem.ts';
import { JOB_LABEL, type Job } from '../jobs/worker.ts';

/** Where the result of a finished job lives in the web app. */
const RESULT_PATH: Record<JobKind, string> = { full_export: '/einstellungen/export' };

export const jobSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  label: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  progress: z.number(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
  resultFileId: z.uuid().nullable(),
  resultPath: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const jobDto = (j: Job): z.infer<typeof jobSchema> => ({
  id: j.id,
  kind: j.kind,
  label: JOB_LABEL[j.kind],
  status: j.status,
  progress: j.progress,
  detail: j.detail,
  error: j.error,
  resultFileId: j.result_file_id,
  resultPath: RESULT_PATH[j.kind],
  createdAt: j.created_at.toISOString(),
  finishedAt: j.finished_at?.toISOString() ?? null,
});

export const jobRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  const tags = ['system'];
  // Users see their own jobs only: a job's detail can name what it works on.
  const own = (organizationId: string, userId: string | null) => db.selectFrom('job').selectAll().where('organization_id', '=', organizationId).where('created_by', '=', userId ?? '00000000-0000-0000-0000-000000000000');

  app.get('/jobs', { schema: { tags, summary: 'Eigene Hintergrundaufgaben: laufende und die der letzten 24 Stunden', response: { 200: z.array(jobSchema) } } }, async (req) => {
    const actor = requireActor(req);
    const rows = await own(actor.organizationId, actor.userId)
      .where((eb) => eb.or([eb('status', 'in', ['queued', 'running']), eb('created_at', '>', new Date(Date.now() - 86_400_000))]))
      .orderBy('created_at', 'desc').limit(20).execute();
    return rows.map(jobDto);
  });

  app.get('/jobs/:id', { schema: { tags, summary: 'Eine Hintergrundaufgabe', params: z.object({ id: z.uuid() }), response: { 200: jobSchema } } }, async (req) => {
    const actor = requireActor(req);
    const j = await own(actor.organizationId, actor.userId).where('id', '=', req.params.id).executeTakeFirst();
    if (!j) throw notFound('Aufgabe');
    return jobDto(j);
  });
};
