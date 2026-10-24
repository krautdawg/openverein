import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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

  it('gives the same answer for unknown e-mail and wrong password, and locks after 5 failures', async () => {
    await setupClub(ctx.app);
    const unknown = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'nobody@example.org', password: 'x' } });
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'erika@example.org', password: 'x' } });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().title).toBe(unknown.json().title);
    for (let i = 0; i < 4; i++) await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'erika@example.org', password: 'x' } });
    const locked = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'erika@example.org', password: 'korrekt-pferd-batterie' } });
    expect(locked.statusCode).toBe(429);
  });

  it('logout ends the session', async () => {
    const { cookie } = await setupClub(ctx.app);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect((await ctx.app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('audit log', () => {
  it('is append-only at the database level', async () => {
    await setupClub(ctx.app);
    await expect(ctx.db.updateTable('audit_event').set({ action: 'tampered' }).execute()).rejects.toThrow(/append-only/);
    await expect(ctx.db.deleteFrom('audit_event').execute()).rejects.toThrow(/append-only/);
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
