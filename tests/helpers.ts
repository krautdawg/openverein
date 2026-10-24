import { sql } from 'kysely';
import { buildApp } from '../src/server/app.ts';
import { createDb, type Db } from '../src/server/db.ts';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://openverein:openverein@localhost:54329/openverein_test';

export async function testApp() {
  const db = createDb(url);
  await reset(db);
  const app = await buildApp(db, { serveWeb: false, authRateLimit: 10_000 });
  await app.ready();
  return { app, db, close: async () => { await app.close(); await db.destroy(); } };
}

/**
 * Empties every table except the migration log. The audit log refuses TRUNCATE, so tests switch
 * triggers off for this one transaction (needs a superuser, which only the test database has).
 */
export async function reset(db: Db) {
  const { rows } = await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migration'`.execute(db);
  if (!rows.length) return;
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`).execute(tx);
  });
}

type App = Awaited<ReturnType<typeof testApp>>['app'];

/** Runs the first-run setup and returns the session cookie header for later requests. */
export async function setupClub(app: App, overrides: Partial<{ clubName: string; email: string; password: string }> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: { clubName: 'TSV Musterstadt 1890 e.V.', name: 'Erika Mustermann', email: 'erika@example.org', password: 'korrekt-pferd-batterie', ...overrides },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'ov_session');
  return { cookie: `ov_session=${cookie!.value}`, me: res.json() };
}
