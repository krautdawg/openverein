import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/server/config.ts';
// @ts-expect-error a plain .mjs file served to users, without types
import { buildRequest, main, operations, tokenTargetAllowed } from '../src/web/public/ov.mjs';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Change agent-access, slice 3: the CLI calls operations by id with the person's token, against a real server. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-cli-'));
const ctx = await testApp();
let base = '';
beforeAll(async () => {
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`;
});
afterAll(() => ctx.close());

let token: string;
beforeEach(async () => {
  await reset(ctx.db);
  const admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
  await admin.post('/members', { firstName: 'Clara', lastName: 'Kommandozeile', joinDate: '2024-01-01' });
  token = (await admin.post('/personal-tokens', { name: 'Terminal', access: 'write' })).body.token;
});

async function ov(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(s));
  const error = vi.spyOn(console, 'error').mockImplementation((s: string) => void err.push(s));
  try {
    const code = await main(args, { OV_URL: base, OV_TOKEN: token, ...env });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('ov CLI', () => {
  it('lists and finds operations, and calls them with the token (logged as CLI)', async () => {
    expect((await ov([])).out).toContain('getMembers');
    expect((await ov(['suche', 'mitglied', 'anlegen'])).out).toContain('postMembers');
    const list = await ov(['getMembers', '--limit', '5']);
    expect(list.code, list.err).toBe(0);
    const m = JSON.parse(list.out).items[0];
    expect(m.lastName).toBe('Kommandozeile');
    const patched = await ov(['patchMembersId', m.id, '--json', '{"firstName":"Klara"}']);
    expect(patched.code, patched.err).toBe(0);
    expect(JSON.parse(patched.out).firstName).toBe('Klara');
    const made = await ov(['postMembers', '--lastName', 'Neu', '--joinDate', '2024-01-01']);
    expect(made.code, made.err).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    const channels = await ctx.db.selectFrom('agent_call').select('channel').distinct().execute();
    expect(channels.map((c) => c.channel)).toEqual(['cli']);
  });

  it('uploads and downloads files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ov-cli-io-'));
    await writeFile(join(dir, 'satzung.pdf'), '%PDF-1.4 Satzung');
    const up = await ov(['postFiles', '--datei', join(dir, 'satzung.pdf')]);
    expect(up.code, up.err).toBe(0);
    const id = JSON.parse(up.out).id;
    const down = await ov(['getFilesIdContent', id, '--ausgabe', join(dir, 'zurueck.pdf')]);
    expect(down.code, down.err).toBe(0);
    expect(await readFile(join(dir, 'zurueck.pdf'), 'utf8')).toBe('%PDF-1.4 Satzung');
  });

  it('reports API errors, refuses OAuth grants and keeps the token away from plain HTTP hosts', async () => {
    const bad = await ov(['postMembers', '--lastName', '']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/HTTP 400/);
    expect((await ov(['getAuthMe'], { OV_TOKEN: 'ov_oat_x_y' })).code).toBe(2);
    expect(tokenTargetAllowed('http://verein.example.org')).toBe(false);
    expect(tokenTargetAllowed('https://verein.example.org')).toBe(true);
    expect(tokenTargetAllowed('http://localhost:3000')).toBe(true);
    const op = { id: 'getMembersId', method: 'GET', path: '/api/v1/members/{id}', params: ['id'] };
    expect(() => buildRequest(op, ['..'], {}, undefined)).toThrow(/Ungültig/);
    expect(buildRequest(op, ['a/b'], {}, undefined).path).toBe('/api/v1/members/a%2Fb');
    expect(operations({ paths: { '/x': { get: { operationId: 'getX' }, head: { operationId: 'headX' } } } }).map((o: { id: string }) => o.id)).toEqual(['getX']);
  });
});
