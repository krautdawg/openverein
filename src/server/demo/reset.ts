import { sql } from 'kysely';
import type { Db } from '../db.ts';
import { seedDemo } from './seed.ts';

let resetting = false;
/** True while this instance rebuilds the demo: the API answers 503 meanwhile (a visitor cannot collide with the seed). */
export const demoResetting = () => resetting;

/**
 * Resets the demo when the last reset is older than `hours` (also right at start-up, so restarts cannot postpone it
 * for ever). One instance at a time: a session advisory lock elects the one that resets (Codex review of #11).
 */
export async function resetDemoIfDue(db: Db, hours: number) {
  if (hours <= 0) return false;
  const last = await db.selectFrom('instance_setting').select('value').where('key', '=', 'demo_last_reset').executeTakeFirst();
  if (last && Date.now() - Date.parse(last.value) < hours * 3_600_000) return false;
  return db.connection().execute(async (conn) => {
    const got = await sql<{ ok: boolean }>`select pg_try_advisory_lock(hashtext('openverein:demo-reset')) as ok`.execute(conn);
    if (!got.rows[0]?.ok) return false;
    resetting = true;
    try {
      await seedDemo(db, { reset: true });
      await markDemoReset(db);
      return true;
    } finally {
      resetting = false;
      await sql`select pg_advisory_unlock(hashtext('openverein:demo-reset'))`.execute(conn);
    }
  });
}

export async function markDemoReset(db: Db) {
  const now = new Date().toISOString();
  await db.insertInto('instance_setting').values({ key: 'demo_last_reset', value: now }).onConflict((oc) => oc.column('key').doUpdateSet({ value: now, updated_at: new Date() })).execute();
}
