import { sql } from 'kysely';
import type { Db } from '../db.ts';

/** Serialises everything that changes fee inputs or posts them (fee runs, schedules, households). Take it first. */
export const lockFees = (tx: Db, organizationId: string) => sql`select pg_advisory_xact_lock(hashtext(${`fees:${organizationId}`}))`.execute(tx);
