import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { sweepFiles } from '../src/server/files/store.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

config.filesDir = await mkdtemp(join(tmpdir(), 'ov-files-'));
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  await rm(config.filesDir, { recursive: true, force: true });
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
});

const upload = (query: string, body: string | Buffer, as = cookie, type = 'application/pdf') =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/files?${query}`, headers: { cookie: as, 'content-type': 'application/octet-stream', 'x-file-type': type }, payload: body });
const blobs = async () => (await Promise.all((await readdir(config.filesDir)).map((d) => readdir(join(config.filesDir, d))))).flat();

describe('documents', () => {
  it('stores identical bytes once, serves them back verified, and keeps versions', async () => {
    const satzung = (await admin.post('/folders', { name: 'Satzung' })).body;
    const a = await upload(`name=Satzung.pdf&folderId=${satzung.id}`, '%PDF-1 Fassung 1');
    expect(a.statusCode, a.body).toBe(201);
    await upload('name=Kopie.pdf', '%PDF-1 Fassung 1');
    expect(await blobs()).toHaveLength(1);
    const v2 = await ctx.app.inject({ method: 'POST', url: `/api/v1/files/${a.json().id}/versions`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf' }, payload: '%PDF-1 Fassung 2' });
    expect(v2.statusCode, v2.body).toBe(201);
    expect(v2.json().version).toBe(2);
    expect((await admin.get(`/files?folderId=${satzung.id}`)).body).toHaveLength(1);
    expect((await admin.get(`/files/${v2.json().id}/versions`)).body.map((f: { version: number }) => f.version)).toEqual([2, 1]);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${a.json().id}/content`, headers: { cookie } });
    expect(dl.body).toBe('%PDF-1 Fassung 1');
    expect(dl.headers['content-disposition']).toContain('attachment');
    // Uploads need the octet-stream type and our origin.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/files?name=x', headers: { cookie, 'content-type': 'text/plain' }, payload: 'x' })).statusCode).toBe(415);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/members?name=x', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: 'x' })).statusCode).toBe(415);
  });

  it('refuses deleting vouchers and held files, sweeps unused bytes only after an hour', async () => {
    const beleg = (await upload('name=Quittung.pdf&retentionClass=voucher', 'quittung')).json();
    expect(beleg.retainUntil).toMatch(/^\d{4}-12-31$/);
    expect((await admin.del(`/files/${beleg.id}`)).status).toBe(409);
    const held = (await upload('name=Protokoll.pdf', 'protokoll')).json();
    await admin.patch(`/files/${held.id}`, { legalHold: true });
    expect((await admin.del(`/files/${held.id}`)).status).toBe(409);
    await admin.patch(`/files/${held.id}`, { legalHold: false, retentionClass: 'document' });
    expect((await admin.del(`/files/${held.id}`)).status).toBe(204);
    expect(await sweepFiles(ctx.db)).toBe(0); // bytes are younger than an hour
    for (const d of await readdir(config.filesDir)) for (const n of await readdir(join(config.filesDir, d))) await utimes(join(config.filesDir, d, n), new Date(0), new Date(0));
    expect(await sweepFiles(ctx.db)).toBe(1);
    expect(await blobs()).toHaveLength(1); // the voucher stays
  });

  it('limits folders by group and keeps member files with the member record', async () => {
    const tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const vorstand = (await admin.post('/groups', { name: 'Vorstand', shortCode: 'VS' })).body.id;
    const board = (await admin.post('/folders', { name: 'Vorstand', groupIds: [vorstand] })).body;
    const sub = (await admin.post('/folders', { name: 'Protokolle', parentId: board.id })).body;
    expect(sub.restricted).toBe(true);
    await admin.post('/folders', { name: 'Tennis', groupIds: [tennis] });
    await upload(`name=geheim.pdf&folderId=${sub.id}`, 'geheim');
    const trainerCookie = await userWithRole(ctx.app, cookie, 'Trainer:in', [tennis]);
    const trainer = client(ctx.app, { cookie: trainerCookie });
    expect((await trainer.get('/folders')).body.map((f: { name: string }) => f.name)).toEqual(['Tennis']);
    expect((await trainer.get(`/files?folderId=${sub.id}`)).status).toBe(404);
    const m = (await admin.post('/members', { lastName: 'Anders', joinDate: '2024-01-01' })).body.id;
    const own = await upload(`name=Antrag.pdf&memberId=${m}`, 'antrag');
    expect(own.statusCode, own.body).toBe(201);
    expect((await admin.get(`/files?memberId=${m}`)).body).toHaveLength(1);
    expect((await trainer.get(`/files?memberId=${m}`)).status).toBe(404); // not in the trainer's groups
    expect((await admin.del(`/folders/${board.id}`)).status).toBe(409);
  });

  it('treats a document as its whole version chain', async () => {
    const v1 = (await upload('name=Export.csv&retentionClass=temporary', 'v1', cookie, 'text/csv')).json();
    const v2 = (await ctx.app.inject({ method: 'POST', url: `/api/v1/files/${v1.id}/versions`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: 'v2' })).json();
    // Old versions cannot be changed or deleted on their own.
    expect((await admin.patch(`/files/${v1.id}`, { legalHold: true })).status).toBe(409);
    expect((await admin.del(`/files/${v1.id}`)).status).toBe(409);
    // A hold on the current version protects the whole chain from the 7-day expiry.
    await admin.patch(`/files/${v2.id}`, { legalHold: true });
    await ctx.db.updateTable('file').set({ created_at: new Date(Date.now() - 8 * 86_400_000), temporary_since: new Date(Date.now() - 8 * 86_400_000) }).execute();
    await sweepFiles(ctx.db);
    expect(await ctx.db.selectFrom('file').select('id').execute()).toHaveLength(2);
    await admin.patch(`/files/${v2.id}`, { legalHold: false });
    await sweepFiles(ctx.db);
    expect(await ctx.db.selectFrom('file').select('id').execute()).toHaveLength(0);

    // An old document made temporary today keeps its seven days from today (Codex review of #5).
    const old = (await upload('name=Alt.pdf', 'alt')).json();
    await ctx.db.updateTable('file').set({ created_at: new Date(Date.now() - 700 * 86_400_000) }).where('id', '=', old.id).execute();
    await admin.patch(`/files/${old.id}`, { retentionClass: 'temporary' });
    await sweepFiles(ctx.db);
    expect(await ctx.db.selectFrom('file').select('id').where('id', '=', old.id).execute()).toHaveLength(1);

    // The name travels in a header, not in the URL.
    const viaHeader = await ctx.app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('Attest Müller.pdf') }, payload: 'x' });
    expect(viaHeader.statusCode, viaHeader.body).toBe(201);
    expect(viaHeader.json().name).toBe('Attest Müller.pdf');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: 'x' })).statusCode).toBe(400);

    // A voucher cannot be turned temporary while its retention runs.
    const beleg = (await upload('name=Beleg.pdf&retentionClass=voucher', 'beleg')).json();
    expect((await admin.patch(`/files/${beleg.id}`, { retentionClass: 'temporary' })).status).toBe(409);
    expect((await admin.patch(`/files/${beleg.id}`, { retentionClass: 'document' })).body.retainUntil).toBe(beleg.retainUntil);

    // Folder moves: unknown parents and cycles are refused.
    const a = (await admin.post('/folders', { name: 'A' })).body;
    const b = (await admin.post('/folders', { name: 'B', parentId: a.id })).body;
    expect((await admin.patch(`/folders/${a.id}`, { parentId: b.id })).status).toBe(409);
    expect((await admin.patch(`/folders/${a.id}`, { parentId: '01a00000-0000-7000-8000-000000000000' })).status).toBe(404);
  });
});
