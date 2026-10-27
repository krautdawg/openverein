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

  it('Codex review G13: a parent who pays for a child but is no member sees the household invoice', async () => {
    const admin = client(ctx.app, { cookie });
    await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
    const plan = (await admin.post('/fee-plans', { name: 'Kinder', version: { validFrom: '2020-01-01', amountCents: 6000, intervalMonths: 12 } })).body.id;
    const kid = (await admin.post('/members', { firstName: 'Kim', lastName: 'Kind', birthDate: '2015-01-01', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2026-01-01' })).body;
    await admin.patch(`/members/${kid.id}/payment-method`, { paymentMethod: 'transfer' });
    await admin.post(`/members/${kid.id}/fee-assignments`, { feePlanId: plan, validFrom: '2026-01-01' });
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    const parent = await ctx.db.insertInto('person').values({ organization_id: org, kind: 'natural', first_name: 'Petra', last_name: 'Kind', email: 'petra.eltern@example.org', street: 'Weg 1', postal_code: '12345', city: 'Musterstadt' }).returning('id').executeTakeFirstOrThrow();
    await admin.post('/households', { name: 'Familie Kind', payerPersonId: parent.id, memberIds: [kid.id] });
    const run = (await admin.post('/fee-runs', { until: '2026-12-31', issueDate: '2026-02-01' })).body;
    expect((await admin.post(`/fee-runs/${run.id}/post`, {})).status).toBe(200);
    const { issueLoginCode } = await import('../src/server/routes/portal.ts');
    const code = await issueLoginCode(ctx.db, org, 'petra.eltern@example.org', null);
    const signed = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email: 'petra.eltern@example.org', code } });
    expect(signed.statusCode, signed.body).toBe(200);
    const portal = [signed.headers['set-cookie']].flat().map(String).map((c) => c.split(';')[0]).join('; ');
    const invoices = (await ctx.app.inject({ url: '/api/v1/portal/invoices', headers: { cookie: portal } })).json();
    expect(invoices).toHaveLength(1);
  });
});
