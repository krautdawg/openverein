import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createLimiter, newToken, PER_HOUR, PER_MINUTE } from '../src/server/agents/tokens.ts';
import { sha256 } from '../src/server/auth/session.ts';
import { issueLoginCode } from '../src/server/routes/portal.ts';
import { processJobs } from '../src/server/jobs/worker.ts';
import { purgeTenant } from '../src/server/tenantPurge.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/** Change agent-access, slice 1: personal tokens act as their person, narrowed, never more. */
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
let org: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const make = async (body: Record<string, unknown>, as = admin) => {
  const r = await as.post('/personal-tokens', { name: 'Claude', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token as string;
};

async function portalCookie(email: string) {
  const code = await issueLoginCode(ctx.db, org, email, null);
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code } });
  expect(res.statusCode, res.body).toBe(200);
  return [res.headers['set-cookie']].flat().map(String).map((c) => c.split(';')[0]).join('; ');
}

describe('admin personal tokens', () => {
  it('act as the access, read-only when asked, and never as a person at the keyboard', async () => {
    const read = client(ctx.app, { token: await make({ access: 'read' }) });
    expect((await read.get('/members')).status).toBe(200);
    expect((await read.post('/members', { lastName: 'Agent', joinDate: '2024-01-01' })).status).toBe(403);
    const write = client(ctx.app, { token: await make({ access: 'write' }) });
    const m = await write.post('/members', { lastName: 'Agent', joinDate: '2024-01-01' });
    expect(m.status).toBe(201);
    // The audit names the person and the agent.
    const ev = await ctx.db.selectFrom('audit_event').select('actor_label').where('action', '=', 'member.created').executeTakeFirstOrThrow();
    expect(ev.actor_label).toBe('Erika Mustermann (Agent: Claude)');
    // No keys, accesses, second factor or step-up for an agent.
    expect((await write.post('/personal-tokens', { name: 'Noch eins' })).status).toBe(403);
    expect((await write.post('/api-tokens', { name: 'Schlüssel', roleId: '01a00000-0000-7000-8000-000000000000' })).status).toBe(403);
    expect((await write.post('/auth/step-up', { code: '123456' })).status).toBe(403);
    expect((await write.post('/members/duplicates/resolve', { keepPersonId: m.body.personId, archivePersonId: m.body.personId })).body.type).toMatch(/step-up-required$/);
    expect((await write.get('/auth/me')).status).toBe(200);
  });

  it('follow the access: module cap, lost role and lock', async () => {
    const events = client(ctx.app, { token: await make({ access: 'write', modules: ['events'] }) });
    expect((await events.get('/members')).status).toBe(403);
    expect((await events.get('/calendars')).status).toBe(200);
    const kasseCookie = await userWithRole(ctx.app, cookie, 'Kassenwart');
    // A fresh session has just confirmed its second factor (userWithRole enrols it), so it may create a token.
    const kasse = client(ctx.app, { cookie: kasseCookie });
    const t = client(ctx.app, { token: await make({ access: 'read' }, kasse) });
    expect((await t.get('/ledger/accounts')).status).toBe(200);
    const users = (await admin.get('/users')).body as { id: string; name: string }[];
    const kasseId = users.find((u) => u.name === 'Kassenwart Test')!.id;
    const trainer = ((await admin.get('/roles')).body as { id: string; name: string }[]).find((r) => r.name === 'Trainer:in')!;
    const re = await admin.patch(`/users/${kasseId}`, { grants: [{ roleId: trainer.id, scopeGroupIds: null }] });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect((await t.get('/ledger/accounts')).status).toBe(403);
    expect((await admin.patch(`/users/${kasseId}`, { status: 'disabled' })).status).toBe(200);
    expect((await t.get('/calendars')).status).toBe(401);
  });

  it('logs each call for the owner (route pattern, no ids), and stops when revoked or expired', async () => {
    const raw = await make({ access: 'read' });
    const t = client(ctx.app, { token: raw });
    const m = (await admin.post('/members', { lastName: 'Log', joinDate: '2024-01-01' })).body;
    await t.get(`/members/${m.id}`);
    await t.get('/members?limit=5');
    await sleep(100);
    const [tok] = (await admin.get('/personal-tokens')).body;
    expect(tok.calls24h).toBe(2);
    expect(tok.recentCalls.map((c: { operation: string }) => c.operation).sort()).toEqual(['GET /members', 'GET /members/:id']);
    expect(JSON.stringify(tok.recentCalls)).not.toContain(m.id);
    expect((await admin.post(`/personal-tokens/${tok.id}/revoke`, {})).body.revoked).toBe(true);
    expect((await t.get('/members')).status).toBe(401);
    const old = await make({ access: 'read' });
    await ctx.db.updateTable('personal_token').set({ expires_at: new Date(Date.now() - 1000) }).where('token_hash', '=', sha256(old)).execute();
    expect((await client(ctx.app, { token: old }).get('/members')).status).toBe(401);
  });

  it('keeps an OAuth grant to /mcp', async () => {
    const user = (await ctx.db.selectFrom('app_user').select('id').executeTakeFirstOrThrow()).id;
    const { prefix, token } = newToken('oauth');
    await ctx.db.insertInto('personal_token').values({ organization_id: org, kind: 'admin', user_id: user, name: 'claude.ai', prefix, token_hash: sha256(token), access: 'read', audience: 'mcp', expires_at: new Date(Date.now() + 86_400_000) }).execute();
    expect((await client(ctx.app, { token }).get('/members')).status).toBe(401);
  });

  it('allows at most ten live tokens per person', async () => {
    for (let i = 0; i < 10; i++) await make({ name: `T${i}` });
    expect((await admin.post('/personal-tokens', { name: 'Elf' })).status).toBe(409);
  });
});

describe('member tokens', () => {
  it('see exactly the portal, are refused at admin routes, and cannot make more tokens', async () => {
    await admin.post('/members', { firstName: 'Mia', lastName: 'Mitglied', email: 'mia@example.org', joinDate: '2024-01-01' });
    const pc = await portalCookie('mia@example.org');
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie: pc }, payload: { name: 'Mein Claude' } });
    expect(created.statusCode, created.body).toBe(201);
    const token = created.json().token as string;
    expect(token.startsWith('ov_mpt_')).toBe(true);
    const viaCookie = (await ctx.app.inject({ url: '/api/v1/portal/me', headers: { cookie: pc } })).json();
    const viaToken = client(ctx.app, { token });
    expect((await viaToken.get('/portal/me')).body).toEqual(viaCookie);
    expect((await viaToken.get('/members')).status).toBe(401);
    expect((await viaToken.post('/portal/tokens', { name: 'Mehr' })).status).toBe(403);
    // Read-only by default: no change requests.
    expect((await viaToken.post('/portal/change-requests', {})).status).toBe(403);
    const list = (await ctx.app.inject({ url: '/api/v1/portal/tokens', headers: { cookie: pc } })).json();
    expect(list[0].recentCalls.length).toBeGreaterThan(0);
  });

  it('are deleted when the person is anonymised', async () => {
    const m = (await admin.post('/members', { firstName: 'Ole', lastName: 'Ehemalig', email: 'ole@example.org', joinDate: '2015-01-01' })).body;
    const pc = await portalCookie('ole@example.org');
    await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie: pc }, payload: { name: 'Agent' } });
    await admin.post(`/members/${m.id}/resign`, { noticeDate: '2020-09-01', exitDate: '2020-12-31' });
    expect((await admin.post(`/persons/${m.personId}/anonymise`, {})).status).toBe(200);
    expect(await ctx.db.selectFrom('personal_token').select('id').execute()).toEqual([]);
  });
});

describe('limit and operation ids', () => {
  it('lets 120 calls a minute and 2000 an hour through, then says when to retry', () => {
    const limit = createLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < PER_MINUTE; i++) expect(limit('a', t0)).toBeNull();
    expect(limit('a', t0)).toBe(60);
    expect(limit('a', t0 + 60_000)).toBeNull();
    const hour = createLimiter();
    for (let i = 0; i < PER_HOUR; i++) expect(hour('b', t0 + i * 1000)).toBeNull();
    expect(hour('b', t0 + PER_HOUR * 1000)).toBeGreaterThan(0);
    const full = createLimiter(1);
    expect(full('x', t0)).toBeNull();
    expect(full('y', t0)).toBe(60);
  });

  it('answers 429 with Retry-After at the limit', async () => {
    const t = await make({ access: 'read' });
    let last = 0;
    let retry: string | undefined;
    for (let i = 0; i <= PER_MINUTE; i++) {
      const r = await ctx.app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${t}` } });
      last = r.statusCode;
      retry = r.headers['retry-after'] as string | undefined;
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });

  it('gives every operation a unique, stable id', async () => {
    const doc = (await ctx.app.inject({ url: '/api/v1/openapi.json' })).json() as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toMatchSnapshot();
  });
});

describe('review fixes (claude-counsel on #122)', () => {
  it('lets the club be purged after its agents made calls', async () => {
    const t = client(ctx.app, { token: await make({ access: 'read' }) });
    await t.get('/members');
    await sleep(100);
    await purgeTenant(ctx.db, org);
    expect(await ctx.db.selectFrom('agent_call').select('id').execute()).toEqual([]);
  });

  it('revokes the tokens of an access when it is disabled or its second factor reset, so unlocking does not bring them back', async () => {
    const kasseCookie = await userWithRole(ctx.app, cookie, 'Kassenwart');
    const t = client(ctx.app, { token: await make({ access: 'read' }, client(ctx.app, { cookie: kasseCookie })) });
    const kasseId = ((await admin.get('/users')).body as { id: string; name: string }[]).find((u) => u.name === 'Kassenwart Test')!.id;
    await admin.patch(`/users/${kasseId}`, { status: 'disabled' });
    await admin.patch(`/users/${kasseId}`, { status: 'active' });
    expect((await t.get('/calendars')).status).toBe(401);
  });

  it('drops a member token when the address changes', async () => {
    const m = (await admin.post('/members', { firstName: 'Eva', lastName: 'Wechsel', email: 'eva@example.org', joinDate: '2024-01-01' })).body;
    const pc = await portalCookie('eva@example.org');
    const token = (await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie: pc }, payload: { name: 'Agent' } })).json().token as string;
    expect((await client(ctx.app, { token }).get('/portal/me')).status).toBe(200);
    expect((await admin.patch(`/members/${m.id}`, { email: 'eva.neu@example.org' })).status).toBe(200);
    expect((await client(ctx.app, { token }).get('/portal/me')).status).toBe(401);
  });

  it('stops a job its agent started once the token is revoked', async () => {
    const raw = await make({ access: 'write' });
    const tok = await ctx.db.selectFrom('personal_token').select(['id', 'user_id']).where('token_hash', '=', sha256(raw)).executeTakeFirstOrThrow();
    const g = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
    const m = (await admin.post('/members', { lastName: 'Job', joinDate: '2024-01-01' })).body.id;
    const job = await ctx.db.insertInto('job').values({ organization_id: org, kind: 'member_bulk', created_by: tok.user_id, token_id: tok.id, params: JSON.stringify({ ids: [m], action: 'add_to_group', groupId: g, date: '2026-01-01' }) } as never).returning('id').executeTakeFirstOrThrow();
    await ctx.db.updateTable('personal_token').set({ revoked_at: new Date() }).where('id', '=', tok.id).execute();
    await processJobs(ctx.db);
    expect((await ctx.db.selectFrom('job').select('status').where('id', '=', job.id).executeTakeFirstOrThrow()).status).toBe('failed');
  });
});

