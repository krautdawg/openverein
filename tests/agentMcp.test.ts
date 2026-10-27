import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newToken } from '../src/server/agents/tokens.ts';
import { sha256 } from '../src/server/auth/session.ts';
import { issueLoginCode } from '../src/server/routes/portal.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Change agent-access, slice 2: /mcp tools are the API operations the token may call, run through the same routes. */
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let org: string;
beforeEach(async () => {
  await reset(ctx.db);
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rpcId = 0;
async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
  });
  return { status: res.statusCode, headers: res.headers, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null };
}
type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const listed = async (token: string) => ((await rpc(token, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name);
const meta = (tools: string[]) => tools.includes('operation_aufrufen');
/** The operations a token reaches: listed directly, or through the search tool when there are many. */
async function names(token: string) {
  const tools = await listed(token);
  if (!meta(tools)) return tools;
  const r = (await rpc(token, 'tools/call', { name: 'operationen_suchen', arguments: {} })).body.result as Result;
  return (JSON.parse(r.content[0]!.text!) as { operation: string }[]).map((o) => o.operation);
}
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const viaMeta = meta(await listed(token));
  return (await rpc(token, 'tools/call', viaMeta ? { name: 'operation_aufrufen', arguments: { operation: name, eingabe: args } } : { name, arguments: args })).body.result as Result;
}

async function adminToken(body: Record<string, unknown>) {
  const r = await admin.post('/personal-tokens', { name: 'Claude', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token as string;
}
async function memberToken(email: string, access = 'read') {
  const code = await issueLoginCode(ctx.db, org, email, null);
  const v = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code } });
  const cookie = [v.headers['set-cookie']].flat().map(String).map((c) => c.split(';')[0]).join('; ');
  return (await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie }, payload: { name: 'Mein Agent', access } })).json().token as string;
}

describe('MCP', () => {
  it('speaks MCP and lists only what the token may call', async () => {
    const init = await rpc(await adminToken({ access: 'read' }), 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('openverein');
    const read = await names(await adminToken({ access: 'read' }));
    expect(read).toContain('getMembers');
    expect(read).toContain('getAuthMe');
    expect(read.some((n) => /^(post|patch|put|delete)/.test(n))).toBe(false);
    expect(read).not.toContain('postPersonalTokens');
    const events = await names(await adminToken({ access: 'write', modules: ['events'] }));
    expect(events).toContain('postEvents');
    expect(events).not.toContain('getMembers');
    await admin.post('/members', { firstName: 'Mia', lastName: 'Mitglied', email: 'mia@example.org', joinDate: '2024-01-01' });
    const member = await names(await memberToken('mia@example.org'));
    expect(member).toContain('getPortalMe');
    expect(member).toContain('getPortalInvoices');
    expect(member.every((n) => n.startsWith('getPortal'))).toBe(true);
    expect(member).not.toContain('postPortalTokens');
    // A member gets the operations as tools; a full access gets the three tools to search, describe and call them.
    expect(meta(await listed(await memberToken('mia@example.org')))).toBe(false);
    const full = await adminToken({ access: 'write' });
    expect(await listed(full)).toEqual(['operationen_suchen', 'operation_beschreiben', 'operation_aufrufen']);
    const found = await rpc(full, 'tools/call', { name: 'operationen_suchen', arguments: { suche: 'rechnung storno' } });
    expect(found.body.result.content[0].text).toContain('postInvoicesIdCancel');
    const described = await rpc(full, 'tools/call', { name: 'operation_beschreiben', arguments: { operation: 'postMembers' } });
    expect(JSON.parse(described.body.result.content[0].text).eingabe.properties.body).toBeTruthy();
  });

  it('answers a tool call with exactly what the API answers, and logs it once as MCP', async () => {
    await admin.post('/members', { firstName: 'Mia', lastName: 'Mitglied', email: 'mia@example.org', joinDate: '2024-01-01' });
    const token = await memberToken('mia@example.org');
    const viaMcp = await call(token, 'getPortalMe');
    expect(viaMcp.isError).toBeFalsy();
    expect(JSON.parse(viaMcp.content[0]!.text!)).toEqual((await client(ctx.app, { token }).get('/portal/me')).body);
    await sleep(100);
    const log = await ctx.db.selectFrom('agent_call').select(['operation', 'channel']).orderBy('at').execute();
    expect(log).toEqual([{ operation: 'GET /portal/me', channel: 'mcp' }, { operation: 'GET /portal/me', channel: 'rest' }]);
  });

  it('writes through the same route (validation, idempotency, audit), and reports API errors as tool errors', async () => {
    const token = await adminToken({ access: 'write' });
    const made = await call(token, 'postMembers', { body: { lastName: 'Per MCP', joinDate: '2024-01-01' } });
    expect(made.isError).toBeFalsy();
    const id = JSON.parse(made.content[0]!.text!).id;
    const patched = await call(token, 'patchMembersId', { id, body: { firstName: 'Max' } });
    expect(patched.isError, patched.content[0]!.text).toBeFalsy();
    const bad = await call(token, 'postMembers', { body: { lastName: '' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/^HTTP 400/);
    const ev = await ctx.db.selectFrom('audit_event').select('actor_label').where('action', '=', 'member.created').executeTakeFirstOrThrow();
    expect(ev.actor_label).toBe('Erika Mustermann (Agent: Claude)');
    expect((await call(token, 'getMembersId', { id: '..' })).isError).toBe(true);
  });

  it('refuses requests without a personal token, and takes an OAuth grant that REST refuses', async () => {
    const none = await rpc(null, 'tools/list');
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Bearer/);
    expect((await ctx.app.inject({ url: '/mcp' })).statusCode).toBe(405);
    const user = (await ctx.db.selectFrom('app_user').select('id').executeTakeFirstOrThrow()).id;
    const { prefix, token } = newToken('oauth');
    await ctx.db.insertInto('personal_token').values({ organization_id: org, kind: 'admin', user_id: user, name: 'claude.ai', prefix, token_hash: sha256(token), access: 'read', audience: 'mcp', expires_at: new Date(Date.now() + 86_400_000) }).execute();
    expect((await client(ctx.app, { token }).get('/auth/me')).status).toBe(401);
    const me = await call(token, 'getAuthMe');
    expect(me.isError, me.content[0]!.text).toBeFalsy();
    expect(JSON.parse(me.content[0]!.text!).email).toBe('erika@example.org');
  });
});
