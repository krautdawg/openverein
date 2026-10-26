import type { z } from 'zod';
import type { bulkBody } from '../../shared/members.ts';
import { JobError, type JobContext } from '../jobs/job.ts';
import { can } from '../policy.ts';
import { memberBulk } from './bulk.ts';

/** A bulk action over many members, with the starting user's current rights and scope. */
export async function runMemberBulk({ db, job, actor, progress, owned }: JobContext) {
  // A retry after a crash between commit and finish: the changes and their result are already stored.
  if (job.result) return { result: job.result };
  if (!can(actor, 'members', 'write')) throw new JobError('Dir fehlt inzwischen das Schreibrecht für Mitglieder.');
  const input = job.params as z.infer<typeof bulkBody>;
  await progress(0.1, `${input.ids.length} Mitglieder`);
  // The changes and their result commit together, and only while this run still owns the job.
  const result = await memberBulk(db, actor, input, {
    before: owned,
    after: async (tx, r) => {
      await tx.updateTable('job').set({ result: JSON.stringify(r) }).where('id', '=', job.id).execute();
    },
  });
  return { result };
}
