import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { issueLoginCode } from '../src/server/routes/portal.ts';
import { getBlob, putBlob } from '../src/server/files/store.ts';
import { stripPhotoMetadata } from '../src/server/profiles/service.ts';
import { HOME, JPEG, JPEG_GPS, JPEG_PROGRESSIVE_GPS, PNG_GPS, WEBP_ANIMATED, WEBP_GPS } from './photos.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/** Change public-profiles, slice 2: the board's approval and the public feed. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-profiles-feed-'));
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let adminCookie: string;
let org: string;
beforeEach(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
  expect((await admin.put('/profile-types', { types: [{ key: 'enthusiast', label: 'KI-Enthusiast' }, { key: 'profi', label: 'KI-Profi' }] })).status).toBe(200);
});

const feed = (headers: Record<string, string> = {}) => ctx.app.inject({ url: '/api/v1/public/profiles', headers });
const full = { displayName: 'Petra P.', bio: 'Baut Agenten.', place: 'Werder', organisation: null, links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/petra' }], typeKey: 'profi', contactVisibility: 'board', hidden: false };

async function member(email: string) {
  const m = (await admin.post('/members', { firstName: 'Petra', lastName: 'Profil', email, joinDate: '2015-01-01' })).body as { id: string; personId: string };
  const code = await issueLoginCode(ctx.db, org, email, null);
  const v = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code } });
  const pc = [v.headers['set-cookie']].flat().map(String).map((c) => c.split(';')[0]).join('; ');
  const save = (body: unknown) => ctx.app.inject({ method: 'PUT', url: `/api/v1/portal/profiles/${m.id}`, headers: { cookie: pc, 'content-type': 'application/json' }, payload: body as object });
  const approve = async () => {
    const p = (await admin.get(`/members/${m.id}/profile`)).body;
    return admin.post(`/profiles/${m.id}/approve`, { updatedAt: p.updatedAt });
  };
  return { ...m, pc, save, approve };
}

describe('approval and public feed', () => {
  it('lists a profile only after the board approved exactly that version', async () => {
    const m = await member('petra@example.org');
    await m.save(full);
    expect((await admin.get('/profiles')).body.map((p: { memberId: string }) => p.memberId)).toEqual([m.id]);
    expect((await feed()).json().profiles).toEqual([]);
    // The member changes it after the board read it: approving the old version is refused.
    const read = (await admin.get(`/members/${m.id}/profile`)).body;
    await m.save({ ...full, bio: 'Neu.' });
    expect((await admin.post(`/profiles/${m.id}/approve`, { updatedAt: read.updatedAt })).status).toBe(409);
    expect((await m.approve()).body.public).toBe(true);
    const res = await feed();
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json().profiles).toEqual([{ id: expect.any(String), type: 'profi', typeLabel: 'KI-Profi', name: 'Petra P.', bio: 'Neu.', place: 'Werder', organisation: null, links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/petra' }], photoUrl: null, email: null }]);
    expect((await feed({ 'if-none-match': String(res.headers.etag) })).statusCode).toBe(304);
    // The contact goes public only on the member's word.
    await m.save({ ...full, bio: 'Neu.', contactVisibility: 'public' });
    expect((await feed()).json().profiles[0].email).toBe('petra@example.org');
  });

  it('takes a profile out at once when hidden, changed, revoked or when the membership ends', async () => {
    const m = await member('weg@example.org');
    await m.save(full);
    await m.approve();
    const count = async () => (await feed()).json().profiles.length;
    expect(await count()).toBe(1);
    await m.save({ ...full, hidden: true });
    expect(await count()).toBe(0);
    await m.save(full);
    expect(await count()).toBe(1);
    await m.save({ ...full, place: 'Potsdam' });
    expect(await count()).toBe(0);
    await m.approve();
    expect(await count()).toBe(1);
    await admin.post(`/profiles/${m.id}/revoke`, {});
    expect(await count()).toBe(0);
    await m.approve();
    await ctx.db.updateTable('member').set({ status: 'former' }).where('id', '=', m.id).execute();
    expect(await count()).toBe(0);
  });

  it('shows the photo only with the photos consent', async () => {
    const m = await member('foto@example.org');
    await m.save(full);
    await ctx.app.inject({ method: 'POST', url: `/api/v1/portal/profiles/${m.id}/photo`, headers: { cookie: m.pc, 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' }, payload: JPEG });
    await m.approve();
    const id = (await feed()).json().profiles[0].id;
    expect((await feed()).json().profiles[0].photoUrl).toBeNull();
    expect((await ctx.app.inject({ url: `/api/v1/public/profiles/${id}/photo` })).statusCode).toBe(404);
    const c = await admin.post(`/persons/${m.personId}/consents`, { purpose: 'photos', source: 'paper' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const url = (await feed()).json().profiles[0].photoUrl as string;
    expect(url).toMatch(new RegExp(`^${config.publicUrl}/api/v1/public/profiles/${id}/photo\\?v=`));
    const photo = await ctx.app.inject({ url: url.replace(config.publicUrl, '') });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.headers['x-content-type-options']).toBe('nosniff');
    await admin.post(`/consents/${c.body.id}/withdraw`, { source: 'paper' });
    expect((await ctx.app.inject({ url: url.replace(config.publicUrl, '') })).statusCode).toBe(404);
  });

  it('lets the club manage its profile types; a removed type takes its profiles out', async () => {
    expect((await admin.put('/profile-types', { types: [{ key: 'none', label: 'x' }] })).status).toBe(400);
    expect((await admin.put('/profile-types', { types: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] })).status).toBe(400);
    const m = await member('typ@example.org');
    await m.save(full);
    await m.approve();
    expect((await admin.put('/profile-types', { types: [{ key: 'enthusiast', label: 'KI-Enthusiast' }] })).status).toBe(200);
    expect((await feed()).json().profiles).toEqual([]);
    expect((await admin.get(`/members/${m.id}/profile`)).body).toMatchObject({ typeKey: 'none', approved: false });
  });

  it('is an agent tool like everything else', async () => {
    const m = await member('agent@example.org');
    const tok = (await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie: m.pc, 'content-type': 'application/json' }, payload: { name: 'Agent' } })).json().token as string;
    const r = await ctx.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
    const names = (r.json().result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('getPublicProfiles');
    expect(names).not.toContain('getPublicProfilesIdPhoto');
  });

  it('review fixes: board routes club-wide, photo of exactly the public version, types locked against approval', async () => {
    const m = await member('fix@example.org');
    await m.save(full);
    // A grant limited to a group neither sees nor approves the club's profiles, nor sets the club's types.
    const g = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
    const scoped = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Admin', [g], 'scoped@example.org') });
    expect((await scoped.get('/profiles')).status).toBe(403);
    expect((await scoped.get(`/members/${m.id}/profile`)).status).toBe(403);
    expect((await scoped.put('/profile-types', { types: [] })).status).toBe(403);
    // An old photo address never serves another photo.
    await ctx.app.inject({ method: 'POST', url: `/api/v1/portal/profiles/${m.id}/photo`, headers: { cookie: m.pc, 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' }, payload: JPEG });
    await admin.post(`/persons/${m.personId}/consents`, { purpose: 'photos', source: 'paper' });
    await m.approve();
    const url = (await feed()).json().profiles[0].photoUrl.replace(config.publicUrl, '') as string;
    expect((await ctx.app.inject({ url })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: url.replace(/v=[^&]+/, 'v=0000000000000000') })).statusCode).toBe(404);
    // CORS also on errors, so a website sees the status.
    expect((await ctx.app.inject({ url: url.replace(/v=[^&]+/, 'v=0000000000000000') })).headers['access-control-allow-origin']).toBe('*');
    // A type that went away cannot be approved.
    await m.save({ ...full, bio: 'Neue Fassung.' });
    await ctx.db.updateTable('organization').set({ profile_types: JSON.stringify([{ key: 'enthusiast', label: 'KI-Enthusiast' }]) as never }).execute();
    expect((await m.approve()).status).toBe(409);
  });

  it('review fix: the feed tool works under managed hosting (the host goes along)', async () => {
    await reset(ctx.db);
    config.multiTenant = true;
    config.operatorToken = 'o'.repeat(40);
    try {
      const t = await ctx.app.inject({ method: 'POST', url: '/api/v1/operator/tenants', headers: { 'x-operator-token': config.operatorToken }, payload: { clubName: 'TSV A', hostname: 'verein-a.example.org', adminName: 'Ada Admin', adminEmail: 'admin@verein-a.example.org' } });
      const a = t.json().id as string;
      const userId = (await ctx.db.selectFrom('app_user').select('id').where('organization_id', '=', a).executeTakeFirstOrThrow()).id;
      const { newToken } = await import('../src/server/agents/tokens.ts');
      const { sha256 } = await import('../src/server/auth/session.ts');
      const { prefix, token } = newToken('admin');
      await ctx.db.insertInto('personal_token').values({ organization_id: a, kind: 'admin', user_id: userId, name: 'Agent', prefix, token_hash: sha256(token), access: 'read', expires_at: new Date(Date.now() + 86_400_000) }).execute();
      const r = await ctx.app.inject({ method: 'POST', url: '/mcp', headers: { host: 'verein-a.example.org', 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'operation_aufrufen', arguments: { operation: 'getPublicProfiles', eingabe: {} } } } });
      const res = r.json().result;
      expect(res.isError, res.content[0].text).toBeFalsy();
      expect(JSON.parse(res.content[0].text)).toEqual({ profiles: [] });
    } finally {
      config.multiTenant = false;
      config.operatorToken = '';
    }
  });

  it('never publishes camera metadata: stripped on upload, and on serving photos stored before', async () => {
    const m = await member('gps@example.org');
    await m.save(full);
    await admin.post(`/persons/${m.personId}/consents`, { purpose: 'photos', source: 'paper' });
    const served = async (headers: Record<string, string> = {}) => {
      await m.approve();
      const url = (await feed()).json().profiles[0].photoUrl.replace(config.publicUrl, '') as string;
      const r = await ctx.app.inject({ url, headers });
      expect(r.statusCode).toBe(200);
      return r.rawPayload;
    };
    for (const [bytes, type] of [[JPEG_GPS, 'image/jpeg'], [JPEG_PROGRESSIVE_GPS, 'image/jpeg'], [PNG_GPS, 'image/png'], [WEBP_GPS, 'image/webp']] as const) {
      expect(bytes.includes(HOME)).toBe(true);
      const up = await ctx.app.inject({ method: 'POST', url: `/api/v1/portal/profiles/${m.id}/photo`, headers: { cookie: m.pc, 'content-type': 'application/octet-stream', 'x-file-type': type }, payload: bytes });
      expect(up.statusCode, up.body).toBe(200);
      const f = await ctx.db.selectFrom('file').innerJoin('member_profile', 'member_profile.photo_file_id', 'file.id').select('file.sha256').executeTakeFirstOrThrow();
      const stored = await getBlob(f.sha256);
      expect(stored.includes(HOME), type).toBe(false);
      expect((await served()).includes(HOME), type).toBe(false);
    }
    // JPEG keeps the orientation (6: turned right) so the photo stays upright; WebP no longer claims EXIF or XMP.
    // (Checked once with Pillow: every cleaned fixture decodes to the same pixels.)
    const jpeg = stripPhotoMetadata(JPEG_GPS, 'image/jpeg')!;
    expect(jpeg.includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6]))).toBe(true);
    expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(stripPhotoMetadata(JPEG_PROGRESSIVE_GPS, 'image/jpeg')!.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(stripPhotoMetadata(WEBP_GPS, 'image/webp')![20]! & 0x2c).toBe(0);
    expect(stripPhotoMetadata(JPEG, 'image/jpeg')).toEqual(JPEG);
    // Animated WebP is refused (no profile photo needs it, and its frames are containers of their own).
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/portal/profiles/${m.id}/photo`, headers: { cookie: m.pc, 'content-type': 'application/octet-stream', 'x-file-type': 'image/webp' }, payload: WEBP_ANIMATED })).statusCode).toBe(415);
    // A file that doesn't parse is refused, not stored or served raw.
    const broken = Buffer.concat([JPEG_GPS.subarray(0, 30)]);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/portal/profiles/${m.id}/photo`, headers: { cookie: m.pc, 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' }, payload: broken })).statusCode).toBe(415);
    // A photo stored before uploads were cleaned is cleaned on its way out.
    const sha = await putBlob(JPEG_GPS);
    await ctx.db.updateTable('file').set({ sha256: sha, size_bytes: JPEG_GPS.length, mime_type: 'image/jpeg' }).where('purpose', '=', 'photo').execute();
    expect((await served()).includes(HOME)).toBe(false);
    // A cache that kept the uncleaned copy under the stored hash gets the clean photo, not a 304.
    expect((await served({ 'if-none-match': `"${sha}"` })).includes(HOME)).toBe(false);
  });
});
