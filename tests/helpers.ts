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

/** JSON request helper bound to a cookie or bearer token. */
export function client(app: App, auth: { cookie?: string; token?: string }) {
  const headers = { ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) };
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers, ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null, headers: res.headers };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body?: unknown) => call('POST', url, body),
    patch: (url: string, body?: unknown) => call('PATCH', url, body),
    put: (url: string, body?: unknown) => call('PUT', url, body),
    del: (url: string) => call('DELETE', url),
  };
}

/** Creates a user with a built-in role (optionally scoped), accepts the invite and returns a cookie. */
export async function userWithRole(app: App, adminCookie: string, builtinName: string, scopeGroupIds: string[] | null = null, email = `${builtinName.toLowerCase().replace(/\W/g, '')}@example.org`) {
  const admin = client(app, { cookie: adminCookie });
  const roles = (await admin.get('/roles')).body as { id: string; name: string }[];
  const role = roles.find((r) => r.name === builtinName)!;
  const created = await admin.post('/users', { name: builtinName + ' Test', email, grants: [{ roleId: role.id, scopeGroupIds }] });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token: created.body.inviteToken, password: 'ein-sehr-langes-passwort' } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return `ov_session=${res.cookies.find((c) => c.name === 'ov_session')!.value}`;
}
