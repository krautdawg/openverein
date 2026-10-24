import pg from 'pg';
import { migrate } from '../src/server/migrate.ts';

export const testDbUrl = process.env.TEST_DATABASE_URL ?? 'postgres://openverein:openverein@localhost:54329/openverein_test';

/** Recreates the test database from scratch and runs every migration once per test run. */
export default async function setup() {
  const url = new URL(testDbUrl);
  const name = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(testDbUrl), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  await admin.end();
  await migrate(testDbUrl, () => {});
}
