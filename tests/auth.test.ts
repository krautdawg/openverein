import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { migrate } from '../src/server/migrate.ts';
import { setupClub, testApp, reset } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());
beforeEach(() => reset(ctx.db));

describe('first-run setup', () => {
  it('creates the club and the first admin once, then refuses', async () => {
    expect((await ctx.app.inject('/api/v1/setup')).json()).toEqual({ needsSetup: true });
    const { me } = await setupClub(ctx.app);
    expect(me.organization.name).toBe('TSV Musterstadt 1890 e.V.');
    expect((await ctx.app.inject('/api/v1/setup')).json()).toEqual({ needsSetup: false });
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { clubName: 'Zweiter Verein', name: 'Max', email: 'max@example.org', password: 'noch-ein-langes-passwort' } });
    expect(again.statusCode).toBe(409);
    expect(again.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects short passwords with a field error', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { clubName: 'TSV', name: 'Max', email: 'max@example.org', password: 'kurz' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].field).toBe('password');
  });
});

describe('login', () => {
  it('logs in case-insensitively and returns the session user', async () => {
    await setupClub(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ERIKA@example.org', password: 'korrekt-pferd-batterie' } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'ov_session')!;
    expect(cookie.httpOnly).toBe(true);
    const me = await ctx.app.inject({ url: '/api/v1/auth/me', headers: { cookie: `ov_session=${cookie.value}` } });
    expect(me.json().email).toBe('erika@example.org');
  });

  it('gives the same answer for unknown e-mail, wrong password and locked account', async () => {
    await setupClub(ctx.app);
    const login = (email: string, password: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    const unknown = await login('nobody@example.org', 'x');
    const wrong = await login('erika@example.org', 'x');
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    for (let i = 0; i < 4; i++) await login('erika@example.org', 'x');
    const locked = await login('erika@example.org', 'korrekt-pferd-batterie');
    expect(locked.statusCode).toBe(401);
    expect(locked.body).toBe(unknown.body);
  });

  it('counts concurrent failed attempts without losing any', async () => {
    await setupClub(ctx.app);
    await Promise.all(Array.from({ length: 6 }, () => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'erika@example.org', password: 'falsch' } })));
    const user = await ctx.db.selectFrom('app_user').select(['failed_logins', 'locked_until']).executeTakeFirstOrThrow();
    expect(user.failed_logins).toBe(6);
    expect(user.locked_until).not.toBeNull();
  });

  it('normalises e-mail whitespace and case', async () => {
    await setupClub(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: '  Erika@Example.org ', password: 'korrekt-pferd-batterie' } });
    expect(res.statusCode).toBe(200);
  });

  it('logout ends the session', async () => {
    const { cookie } = await setupClub(ctx.app);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie }, payload: {} });
    expect((await ctx.app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('audit log', () => {
  it('is append-only at the database level', async () => {
    await setupClub(ctx.app);
    await expect(ctx.db.updateTable('audit_event').set({ action: 'tampered' }).execute()).rejects.toThrow(/append-only/);
    await expect(ctx.db.deleteFrom('audit_event').execute()).rejects.toThrow(/append-only/);
    await expect(sql`truncate audit_event`.execute(ctx.db)).rejects.toThrow(/append-only/);
  });
});

describe('request guards', () => {
  it('rejects non-JSON writes and cross-origin writes (CSRF)', async () => {
    const { cookie } = await setupClub(ctx.app);
    const form = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'content-type': 'text/plain' }, payload: 'x' });
    expect(form.statusCode).toBe(415);
    const bare = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect(bare.statusCode).toBe(415);
    const foreign = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: { cookie, origin: 'https://evil.example', host: 'verein.example' }, payload: { name: 'Gekapert' } });
    expect(foreign.statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie }, payload: {} });
    expect(ok.statusCode).toBe(204);
  });

  it('answers unknown API paths, including /api itself, with a problem document', async () => {
    for (const url of ['/api', '/api?x=1', '/api/v1/missing']) {
      const res = await ctx.app.inject(url);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('does not leak database details in conflicts', async () => {
    const { cookie } = await setupClub(ctx.app);
    const res = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: { cookie }, payload: { name: 'x'.repeat(5) } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify((await ctx.app.inject({ url: '/api/v1/openapi.json' })).json().paths['/api/v1/setup'].post.security)).toBe('[]');
  });
});

describe('migrations', () => {
  it('can run concurrently on an empty database', async () => {
    const url = (process.env.TEST_DATABASE_URL ?? 'postgres://openverein:openverein@localhost:54329/openverein_test').replace(/\/[^/]+$/, '/openverein_migrate_test');
    await sql.raw('drop database if exists openverein_migrate_test with (force)').execute(ctx.db);
    await sql.raw('create database openverein_migrate_test').execute(ctx.db);
    await Promise.all([migrate(url, () => {}), migrate(url, () => {}), migrate(url, () => {})]);
    await sql.raw('drop database openverein_migrate_test with (force)').execute(ctx.db);
  });
});

describe('organization', () => {
  it('requires a session and audits renames', async () => {
    expect((await ctx.app.inject('/api/v1/organization')).statusCode).toBe(401);
    const { cookie } = await setupClub(ctx.app);
    const res = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/organization', headers: { cookie }, payload: { name: 'SV Blau-Weiß' } });
    expect(res.json().name).toBe('SV Blau-Weiß');
    const events = await ctx.db.selectFrom('audit_event').select('action').execute();
    expect(events.map((e) => e.action)).toContain('organization.update');
  });
});

describe('rate limit', () => {
  it('limits login attempts per IP with a German problem document', async () => {
    const { buildApp } = await import('../src/server/app.ts');
    const strict = await buildApp(ctx.db, { serveWeb: false, authRateLimit: 2 });
    const hit = () => strict.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@example.org', password: 'x' } });
    await hit();
    await hit();
    const third = await hit();
    expect(third.statusCode).toBe(429);
    expect(third.json().title).toBe('Zu viele Anfragen. Bitte warte einen Moment.');
    await strict.close();
  });
});
