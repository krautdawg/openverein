import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.ts';

const dir = new URL('../../migrations/', import.meta.url);

/** Applies every migrations/*.sql file not yet recorded, each in its own transaction. */
/** Ledger of applied migrations; resets and test wipes must keep it. */
export const MIGRATIONS_TABLE = 'schema_migration';

export async function migrate(connectionString: string, log = console.log) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // One migrator at a time (two app containers starting together); taken before any DDL.
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists ${MIGRATIONS_TABLE} (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query<{ name: string }>(`select name from ${MIGRATIONS_TABLE}`)).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, dir), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(`insert into ${MIGRATIONS_TABLE} (name) values ($1)`, [file]);
        await client.query('commit');
        log(`migrated ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  await migrate(config.databaseUrl);
}
