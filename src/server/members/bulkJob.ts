import type { z } from 'zod';
import type { bulkBody } from '../../shared/members.ts';
import { JobError, type JobContext } from '../jobs/job.ts';
import { can } from '../policy.ts';
import { memberBulk } from './bulk.ts';

/** A bulk action over many members, with the starting user's current rights and scope. */
export async function runMemberBulk({ db, job, actor, progress }: JobContext) {
  if (!can(actor, 'members', 'write')) throw new JobError('Dir fehlt inzwischen das Schreibrecht für Mitglieder.');
  const input = job.params as z.infer<typeof bulkBody>;
  await progress(0.1, `${input.ids.length} Mitglieder`);
  const result = await memberBulk(db, actor, input);
  return { result };
}
