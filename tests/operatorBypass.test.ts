import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => {
  config.multiTenant = false;
  config.operatorToken = '';
  return ctx.close();
});

describe('operator API', () => {
  it('cannot be reached around the token check with a percent-encoded path', async () => {
    await reset(ctx.db);
    await setupClub(ctx.app);
    // Single club: the operator API does not exist, encoded or not.
    for (const url of ['/api/v1/operator/tenants', '/api/v1/%6Fperator/tenants', '/api/v1/%6fperator/tenants', '/api/v1/op%65rator/tenants']) {
      expect((await ctx.app.inject({ url })).statusCode, url).toBe(404);
    }
    // Managed hosting: without the token, nothing.
    config.multiTenant = true;
    config.operatorToken = 'o'.repeat(40);
    for (const url of ['/api/v1/operator/tenants', '/api/v1/%6Fperator/tenants', '/api/v1/op%65rator/tenants']) {
      expect((await ctx.app.inject({ url })).statusCode, url).toBe(401);
    }
    expect((await ctx.app.inject({ url: '/api/v1/%6Fperator/tenants', headers: { 'x-operator-token': 'o'.repeat(40) } })).statusCode).toBe(200);
  });
});
