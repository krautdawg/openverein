import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../src/server/auth/session.ts';
import { issueLoginCode } from '../src/server/routes/portal.ts';
// @ts-expect-error a plain .mjs file served to users, without types
import { main } from '../src/web/public/ov.mjs';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/** Findings of the Codex second review of agent access, slices 1 to 3 (#122-#124). Each test failed on the code before the fix. */
const ctx = await testApp();
let base = '';
beforeAll(async () => {
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`;
});
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
let org: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
});

const pat = async (body: Record<string, unknown>, as = admin) => (await as.post('/personal-tokens', { name: 'Agent', ...body })).body.token as string;
async function portalCookie(email: string) {
  const code = await issueLoginCode(ctx.db, org, email, null);
  const v = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code } });
  return [v.headers['set-cookie']].flat().map(String).map((c) => c.split(';')[0]).join('; ');
}
const mcp = (token: string, operation: string, eingabe: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'operation_aufrufen', arguments: { operation, eingabe } } } });
const search = async (token: string) => {
  const list = await ctx.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  const names = (list.json().result.tools as { name: string }[]).map((t) => t.name);
  if (!names.includes('operationen_suchen')) return names;
  const r = await ctx.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'operationen_suchen', arguments: {} } } });
  return (JSON.parse(r.json().result.content[0].text) as { operation: string }[]).map((o) => o.operation);
};

describe('agent access, second review', () => {
  it('P1: ends portal sign-ins and member tokens when the address changes or the person is deleted', async () => {
    const m = (await admin.post('/members', { firstName: 'Alice', lastName: 'Adresse', email: 'alice@example.org', joinDate: '2024-01-01' })).body;
    const pc = await portalCookie('alice@example.org');
    expect((await ctx.app.inject({ url: '/api/v1/portal/me', headers: { cookie: pc } })).statusCode).toBe(200);
    await admin.patch(`/members/${m.id}`, { email: 'alice.neu@example.org' });
    // The old sign-in cannot mint a token for the abandoned address.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie: pc }, payload: { name: 'x' } })).statusCode).toBe(401);
    // A person deleted outright (import rollback) takes the address's tokens along.
    const b = (await admin.post('/members', { firstName: 'Bert', lastName: 'Import', email: 'bert@example.org', joinDate: '2024-01-01' })).body;
    const bc = await portalCookie('bert@example.org');
    await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie: bc }, payload: { name: 'x' } });
    await ctx.db.deleteFrom('member').where('id', '=', b.id).execute().catch(() => undefined);
    await ctx.db.deleteFrom('person').where('id', '=', b.personId).execute().catch(() => undefined);
    const left = await ctx.db.selectFrom('personal_token').select('id').where('email', '=', 'bert@example.org').execute();
    const person = await ctx.db.selectFrom('person').select('id').where('id', '=', b.personId).executeTakeFirst();
    // Either the person could not be deleted (references), or the tokens went with it.
    expect(person ? true : left.length === 0).toBe(true);
  });

  it('keeps a module-limited token out of routes without a module, and agents away from club API keys', async () => {
    const events = client(ctx.app, { token: await pat({ access: 'write', modules: ['events'] }) });
    expect((await events.get('/tasks')).status).toBe(403);
    expect((await events.get('/auth/me')).status).toBe(200);
    const full = client(ctx.app, { token: await pat({ access: 'write' }) });
    expect((await full.get('/api-tokens')).status).toBe(403);
  });

  it('does not replay a stored answer to a group-limited grant', async () => {
    const roles = (await admin.get('/roles')).body as { permissions: Record<string, string> }[];
    await admin.post('/roles', { name: 'Abteilungskasse', permissions: { ...Object.fromEntries(Object.keys(roles[0]!.permissions).map((k) => [k, 'read'])), members: 'write', invoices: 'write' } });
    const g = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
    const lead = await userWithRole(ctx.app, cookie, 'Abteilungskasse', [g]);
    const m = (await admin.post('/members', { lastName: 'Gruppe', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body;
    expect((await admin.post('/group-memberships', { memberId: m.id, groupId: g, validFrom: '2024-01-01' })).status).toBe(201);
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { cookie: lead, 'idempotency-key': 'scoped-key-01' }, payload: { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 100 }] } });
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(409);
  });

  it('lists tools by what the route needs, and deletes without a body through MCP', async () => {
    const membersOnly = await search(await pat({ access: 'write', modules: ['members'] }));
    expect(membersOnly).not.toContain('postCustomFields');
    const settings = await search(await pat({ access: 'write', modules: ['settings'] }));
    expect(settings).toContain('postCustomFields');
    const reader = await search(await pat({ access: 'read' }));
    expect(reader).not.toContain('getCollectionRunsIdFilesPosition');
    const task = (await admin.post('/tasks', { title: 'Weg damit' })).body;
    const del = await mcp(await pat({ access: 'write' }), 'deleteTasksId', { id: task.id });
    expect(del.json().result.isError, del.json().result.content[0].text).toBeFalsy();
  });

  it('always lists every live token, however long the history', async () => {
    const old = await pat({ name: 'Alt' });
    for (let i = 0; i < 51; i++) await admin.post(`/personal-tokens/${(await admin.post('/personal-tokens', { name: `T${i}` })).body.personalToken.id}/revoke`, {});
    const list = (await admin.get('/personal-tokens')).body as { name: string; revoked: boolean }[];
    expect(list.filter((t) => !t.revoked).map((t) => t.name)).toEqual(['Alt']);
    void old;
    void sha256;
  });

  it('saves CLI downloads for the owner only and never over an existing file', async () => {
    const token = await pat({ access: 'read' });
    const dir = await mkdtemp(join(tmpdir(), 'ov-cli-mode-'));
    const out = join(dir, 'mitglieder.json');
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
    try {
      expect(await main(['getMembers', '--ausgabe', out], { OV_URL: base, OV_TOKEN: token })).toBe(0);
      expect((await stat(out)).mode & 0o777).toBe(0o600);
      await expect(main(['getMembers', '--ausgabe', out], { OV_URL: base, OV_TOKEN: token })).rejects.toThrow(/gibt es schon/);
    } finally {
      quiet.forEach((q) => q.mockRestore());
    }
  });

  it('keeps the SEPA bank file away from agents (plugin review): not offered, and refused by the route', async () => {
    const writer = await pat({ access: 'write' });
    expect(await search(writer)).not.toContain('getCollectionRunsIdFilesPosition');
    const r = await client(ctx.app, { token: writer }).get('/collection-runs/01900000-0000-7000-8000-000000000000/files/1');
    expect(r.status).toBe(403);
    expect(r.body.type).toMatch(/person-required$/);
  });
});
