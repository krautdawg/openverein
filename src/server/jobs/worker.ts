import { sql } from 'kysely';
import { capGrants } from '../agents/tokens.ts';
import type { Db, JobKind } from '../db.ts';
import { JobError, type Job, type JobContext } from './job.ts';
import { Problem } from '../http/problem.ts';
import { loadGrants, type Actor } from '../policy.ts';
import { runFullExport } from '../exports/fullJob.ts';
import { runMemberBulk } from '../members/bulkJob.ts';

export type { Job } from './job.ts';

/** A handler checks the actor's current permission itself and returns the result file, if any. */
type Handler = (ctx: JobContext) => Promise<{ fileId?: string; result?: unknown }>;

const HANDLERS: Record<JobKind, Handler> = { full_export: runFullExport, member_bulk: runMemberBulk };
export const JOB_LABEL: Record<JobKind, string> = { full_export: 'Gesamtexport', member_bulk: 'Sammelaktion Mitglieder' };

/** A running job whose claim is older than this counts as crashed; it is retried once, then failed. */
const STALE_MINUTES = 30;
const MAX_ATTEMPTS = 2;

/** The starting user as they are now: a deactivated account or a removed role stops the job. */
async function currentActor(db: Db, job: Job, lock = false): Promise<Actor> {
  const user = job.created_by ? await db.selectFrom('app_user').select(['id', 'name', 'status', 'organization_id']).where('id', '=', job.created_by).executeTakeFirst() : undefined;
  if (!user || user.status !== 'active' || user.organization_id !== job.organization_id) throw new JobError('Das Konto, das die Aufgabe gestartet hat, ist nicht mehr aktiv.');
  const grants = await loadGrants(db, user.id);
  if (!job.token_id) return { kind: 'user', id: user.id, userId: user.id, name: user.name, organizationId: job.organization_id, grants };
  // Started by an agent: its token's narrowed rights, and a revoked or expired token stops the job.
  const q = db.selectFrom('personal_token').selectAll().where('id', '=', job.token_id).where('revoked_at', 'is', null).where('expires_at', '>', new Date());
  // In the mutation's transaction the token row is locked: a revocation either lands before (the job stops) or after.
  const t = await (lock ? q.forShare() : q).executeTakeFirst();
  if (!t) throw new JobError('Das Agenten-Token, das die Aufgabe gestartet hat, gilt nicht mehr.');
  return { kind: 'user', via: 'token', tokenId: t.id, id: user.id, userId: user.id, name: `${user.name} (Agent: ${t.name})`, organizationId: job.organization_id, grants: capGrants(grants, t) };
}

/** Runs queued jobs one after another until none is left; returns how many ran. */
export async function processJobs(db: Db) {
  let n = 0;
  for (;;) {
    const job = await sql<Job>`
      update job set status = 'running', claimed_at = now(), attempts = attempts + 1
      where id = (
        select id from job
        where status = 'queued' or (status = 'running' and claimed_at < now() - make_interval(mins => ${STALE_MINUTES}))
        order by created_at for update skip locked limit 1)
      returning *`.execute(db).then((r) => r.rows[0]);
    if (!job) return n;
    n++;
    // The lease is the attempt number: a run whose job was reclaimed after going stale can no longer write.
    const finish = (set: { status: 'done' | 'failed'; error?: string; result_file_id?: string | null; result?: string | null }) =>
      db.updateTable('job').set({ ...set, progress: set.status === 'done' ? 100 : sql<number>`progress`, finished_at: new Date() }).where('id', '=', job.id).where('attempts', '=', job.attempts).where('status', '=', 'running').execute();
    if (job.attempts > MAX_ATTEMPTS) {
      await finish({ status: 'failed', error: 'Die Aufgabe wurde unterbrochen. Starte sie neu.' });
      continue;
    }
    try {
      const actor = await currentActor(db, job);
      const progress = async (share: number, detail?: string) => {
        const r = await db.updateTable('job').set({ progress: Math.min(99, Math.round(share * 100)), claimed_at: new Date(), ...(detail !== undefined && { detail }) }).where('id', '=', job.id).where('attempts', '=', job.attempts).where('status', '=', 'running').executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new JobError('Die Aufgabe wurde inzwischen neu gestartet.');
      };
      const owned = async (tx: Db) => {
        const row = await tx.selectFrom('job').select('id').where('id', '=', job.id).where('attempts', '=', job.attempts).where('status', '=', 'running').forUpdate().executeTakeFirst();
        if (!row) throw new JobError('Die Aufgabe wurde inzwischen neu gestartet.');
        // The rights as they are now, in this transaction: a revoked token or changed role stops the job before it writes.
        const now = await currentActor(tx, job, true);
        if (JSON.stringify(now.grants) !== JSON.stringify(actor.grants)) throw new JobError('Die Rechte haben sich geändert, seit die Aufgabe begann. Bitte neu starten.');
      };
      const result = await HANDLERS[job.kind]({ db, job, actor, progress, owned });
      await finish({ status: 'done', result_file_id: result.fileId ?? null, result: result.result === undefined ? null : JSON.stringify(result.result) });
    } catch (err) {
      if (!(err instanceof JobError)) console.error('job failed', job.id, job.kind, err);
      // Messages of our own refusals (JobError, Problem) are for the user; anything else stays in the log.
      const shown = err instanceof JobError || err instanceof Problem ? err.message : 'Die Aufgabe ist fehlgeschlagen. Details stehen im Server-Log.';
      await finish({ status: 'failed', error: shown });
    }
  }
}

/** Finished jobs older than 90 days go (their result files expire on their own). */
export async function pruneJobs(db: Db) {
  const r = await db.deleteFrom('job').where('status', 'in', ['done', 'failed']).where('finished_at', '<', new Date(Date.now() - 90 * 86_400_000)).executeTakeFirst();
  return Number(r.numDeletedRows);
}

/** Background loop every 2 seconds, in the web process (one process per install). */
export function startJobWorker(db: Db, log: (err: unknown) => void) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processJobs(db);
    } catch (err) {
      log(err);
    } finally {
      running = false;
    }
  };
  return setInterval(() => void tick(), 2_000).unref();
}
