import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { seedDemo, testIban, wipe } from '../src/server/demo/seed.ts';
import { migrate } from '../src/server/migrate.ts';
import { testDbUrl } from './global-setup.ts';
import { isValidIban } from '../src/shared/iban.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());
beforeEach(() => reset(ctx.db));

describe('demo mode', () => {
  it('makes valid test IBANs', () => {
    for (let i = 0; i < 20; i++) expect(isValidIban(testIban('37040044', 1000000 + i))).toBe(true);
  });

  it('loads the demo club, refuses a second load without reset, and never touches a real club', async () => {
    const r = await seedDemo(ctx.db, { members: 12 });
    expect(r.members).toBe(12);
    expect((await ctx.db.selectFrom('organization').select('is_demo').executeTakeFirstOrThrow()).is_demo).toBe(true);
    expect((await ctx.db.selectFrom('invoice').select('id').execute()).length).toBeGreaterThan(0);
    await expect(seedDemo(ctx.db, { members: 12 })).rejects.toThrow(/schon geladen/);
    await seedDemo(ctx.db, { reset: true, members: 5 });
    expect(await ctx.db.selectFrom('member').select('id').execute()).toHaveLength(5);

    await reset(ctx.db);
    await setupClub(ctx.app);
    await expect(seedDemo(ctx.db, { reset: true })).rejects.toThrow(/echten Verein/);
  }, 120_000);

  it('locks account and upload routes in the public demo', async () => {
    const cookie = (await setupClub(ctx.app)).cookie;
    const admin = client(ctx.app, { cookie });
    config.demoMode = true;
    try {
      expect((await admin.post('/api-tokens', { name: 'x', roleId: '01a00000-0000-7000-8000-000000000000' })).status).toBe(403);
      expect((await admin.post('/users', { name: 'X', email: 'x@example.org', grants: [] })).status).toBe(403);
      expect((await admin.get('/users')).status).toBe(200);
      // Every byte upload and every import is locked, whatever its route (Codex review of #11).
      const raw = (url: string) => ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'a.pdf' }, payload: 'x' });
      expect((await raw('/files')).statusCode).toBe(403);
      expect((await raw('/receipts/files')).statusCode).toBe(403);
      expect((await raw('/portal/expenses/files')).statusCode).toBe(403);
      const cal = (await admin.post('/calendars', { name: 'K' })).body.id;
      expect((await admin.post(`/calendars/${cal}/import`, { content: 'BEGIN:VCALENDAR' })).status).toBe(403);
      // Percent-encoded paths route to the same handler and must hit the same lock.
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/%75sers', headers: { cookie }, payload: { name: 'X', email: 'x@example.org', grants: [] } })).statusCode).toBe(403);
      // Nobody but the demo seed may run setup on a demo instance.
      await reset(ctx.db);
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { clubName: 'Fremd', name: 'X Y', email: 'x@example.org', password: 'ein-langes-passwort' } })).statusCode).toBe(403);
    } finally {
      config.demoMode = false;
    }
  });

  it('tells the web app about the demo (start page, reset interval) only in demo mode', async () => {
    const off = (await ctx.app.inject({ url: '/api/v1/config' })).json();
    expect(off).toEqual({ demo: false, demoLogin: null, demoResetHours: null });
    config.demoMode = true;
    try {
      const on = (await ctx.app.inject({ url: '/api/v1/config' })).json();
      expect(on.demo).toBe(true);
      expect(on.demoResetHours).toBe(config.demoResetHours);
    } finally {
      config.demoMode = false;
    }
  });

  it('keeps the migration ledger when wiping', async () => {
    await wipe(ctx.db);
    await expect(migrate(testDbUrl, () => {})).resolves.not.toThrow();
  });

  it('validates the reset interval and keeps the last reset across restarts', async () => {
    const { demoResetHours } = await import('../src/server/config.ts');
    expect(demoResetHours(undefined)).toBe(24);
    expect(demoResetHours('0')).toBe(0);
    expect(() => demoResetHours('24h')).toThrow(/ganze Zahl/);
    expect(() => demoResetHours('1000')).toThrow();
    const { markDemoReset, resetDemoIfDue } = await import('../src/server/demo/reset.ts');
    await markDemoReset(ctx.db);
    expect(await resetDemoIfDue(ctx.db, 24)).toBe(false);
    expect(await resetDemoIfDue(ctx.db, 0)).toBe(false);
  });
});
