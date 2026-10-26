import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp } from './helpers.ts';

// Own file: a fresh app, so the HTTP rate limit of the sign-in route is not used up by other portal tests.
const ctx = await testApp();
afterAll(() => ctx.close());
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
});

describe('portal sign-in', () => {
  it('Codex review #9: an unknown address gets the same answers as a member (no enumeration)', async () => {
    const verify = (email: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code: '123456' } });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await verify('niemand@example.org')).statusCode);
    expect(statuses).toEqual([...Array(10).fill(400), 429]);
    expect((await verify('niemand@example.org')).json().type).toContain('too-many-attempts');
  });

  it('Codex review G11: a parent who pays for a child member but is no member gets a sign-in code', async () => {
    const admin = client(ctx.app, { cookie });
    const kid = (await admin.post('/members', { firstName: 'Kim', lastName: 'Kind', birthDate: '2015-01-01', joinDate: '2024-01-01' })).body;
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    const parent = await ctx.db.insertInto('person').values({ organization_id: org, kind: 'natural', first_name: 'Paula', last_name: 'Kind', email: 'paula.eltern@example.org' }).returning('id').executeTakeFirstOrThrow();
    expect((await admin.post('/households', { name: 'Familie Kind', payerPersonId: parent.id, memberIds: [kid.id] })).status).toBe(201);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/request-code', payload: { email: 'paula.eltern@example.org' } });
    await new Promise((r) => setTimeout(r, 300));
    const code = await ctx.db.selectFrom('login_code').select('id').where('organization_id', '=', org).executeTakeFirst();
    expect(code).toBeDefined();
  });
});
