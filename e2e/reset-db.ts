import pg from 'pg';

/** Fresh, empty database per e2e run; the server migrates it on start. */
export async function resetDb() {
  const url = new URL(process.env.E2E_DATABASE_URL ?? 'postgres://openverein:openverein@localhost:54329/openverein_e2e');
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  await admin.end();
}
if (import.meta.main) await resetDb();
