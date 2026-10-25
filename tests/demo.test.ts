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
      // Percent-encoded paths route to the same handler and must hit the same lock.
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/%75sers', headers: { cookie }, payload: { name: 'X', email: 'x@example.org', grants: [] } })).statusCode).toBe(403);
      // Nobody but the demo seed may run setup on a demo instance.
      await reset(ctx.db);
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { clubName: 'Fremd', name: 'X Y', email: 'x@example.org', password: 'ein-langes-passwort' } })).statusCode).toBe(403);
    } finally {
      config.demoMode = false;
    }
  });

  it('keeps the migration ledger when wiping', async () => {
    await wipe(ctx.db);
    await expect(migrate(testDbUrl, () => {})).resolves.not.toThrow();
  });
});
