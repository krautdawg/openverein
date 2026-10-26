import type { Selectable } from 'kysely';
import type { Db, JobTable } from '../db.ts';
import type { Actor } from '../policy.ts';

export type Job = Selectable<JobTable>;
export interface JobContext {
  db: Db;
  job: Job;
  actor: Actor;
  progress: (share: number, detail?: string) => Promise<void>;
  /** Locks the job row in `tx` and throws unless this run still owns it (a retry after a stale claim takes over). */
  owned: (tx: Db) => Promise<void>;
}

/** Thrown by handlers for expected refusals: the message is shown to the user as the job's error. */
export class JobError extends Error {}
