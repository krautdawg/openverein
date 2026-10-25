import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reset, setupClub, testApp } from './helpers.ts';

// Own file: a fresh app, so the HTTP rate limit of the sign-in route is not used up by other portal tests.
const ctx = await testApp();
afterAll(() => ctx.close());
beforeEach(async () => {
  await reset(ctx.db);
  await setupClub(ctx.app);
});

describe('portal sign-in', () => {
  it('Codex review #9: an unknown address gets the same answers as a member (no enumeration)', async () => {
    const verify = (email: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code: '123456' } });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await verify('niemand@example.org')).statusCode);
    expect(statuses).toEqual([...Array(10).fill(400), 429]);
    expect((await verify('niemand@example.org')).json().type).toContain('too-many-attempts');
  });
});
