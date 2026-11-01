import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { issueLoginCode } from '../src/server/routes/portal.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Change public-profiles, slice 1: the member's profile in the portal. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-profiles-'));
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
  await ctx.db.updateTable('organization').set({ profile_types: JSON.stringify([{ key: 'enthusiast', label: 'KI-Enthusiast' }, { key: 'profi', label: 'KI-Profi' }]) as never }).execute();
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);

async function member(email: string) {
  const m = (await admin.post('/members', { firstName: 'Petra', lastName: 'Profil', email, joinDate: '2015-01-01' })).body as { id: string; personId: string };
  const code = await issueLoginCode(ctx.db, org, email, null);
  const v = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', payload: { email, code } });
  const pc = [v.headers['set-cookie']].flat().map(String).map((c) => c.split(';')[0]).join('; ');
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, payload?: unknown, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method, url: `/api/v1/portal/profiles/${m.id}${path}`, headers: { cookie: pc, ...(payload !== undefined && !Buffer.isBuffer(payload) ? { 'content-type': 'application/json' } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as never } : {}) });
  return { ...m, pc, call };
}

const full = { displayName: 'Petra P.', bio: 'Baut Agenten für Vereine.', place: 'Werder', organisation: 'Kanzlei P', links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/petra' }, { label: 'Website', url: 'https://petra.example' }], typeKey: 'profi', contactVisibility: 'public', hidden: false };

describe('member profiles', () => {
  it('saves the profile in order, refuses unknown types, and needs approval again after a content change', async () => {
    const m = await member('petra@example.org');
    expect((await m.call('GET', '')).json()).toMatchObject({ typeKey: 'none', contactVisibility: 'board', hidden: false, approved: false, public: false, types: [{ key: 'enthusiast' }, { key: 'profi' }] });
    expect((await m.call('PUT', '', { ...full, typeKey: 'astronaut' })).statusCode).toBe(400);
    expect((await m.call('PUT', '', { ...full, links: [{ label: 'x', url: 'javascript:alert(1)' }] })).statusCode).toBe(400);
    const saved = (await m.call('PUT', '', full)).json();
    expect(saved.links.map((l: { label: string }) => l.label)).toEqual(['LinkedIn', 'Website']);
    expect(saved.public).toBe(false);
    // The board approves (slice 2 adds the queue); hiding and the contact switch keep the approval.
    await ctx.db.updateTable('member_profile').set({ approved_at: new Date() }).execute();
    expect((await m.call('GET', '')).json().public).toBe(true);
    expect((await m.call('PUT', '', { ...full, hidden: true })).json()).toMatchObject({ approved: true, public: false });
    expect((await m.call('PUT', '', { ...full, contactVisibility: 'board' })).json()).toMatchObject({ approved: true, public: true });
    // A new bio is a new version.
    expect((await m.call('PUT', '', { ...full, bio: 'Neu.' })).json()).toMatchObject({ approved: false, public: false });
  });

  it('keeps a photo only when it is an image, replaces the old one, and serves it to its owner', async () => {
    const m = await member('foto@example.org');
    expect((await m.call('POST', '/photo', Buffer.from('%PDF-1.4'), { 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' })).statusCode).toBe(415);
    const one = await m.call('POST', '/photo', JPEG, { 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().photo).toEqual({ size: JPEG.length, type: 'image/jpeg' });
    const two = await m.call('POST', '/photo', PNG, { 'content-type': 'application/octet-stream', 'x-file-type': 'image/png' });
    expect(two.json().photo.type).toBe('image/png');
    expect(await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'photo').execute()).toHaveLength(1);
    const own = await m.call('GET', '/photo');
    expect(own.headers['content-type']).toBe('image/png');
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect((await m.call('DELETE', '/photo', {})).json().photo).toBeNull();
    expect(await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'photo').execute()).toHaveLength(0);
    // Photo files stay out of the club's document lists.
    await m.call('POST', '/photo', JPEG, { 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' });
    expect((await admin.get(`/files?memberId=${m.id}`)).body).toEqual([]);
  });

  it('keeps members to their own profile', async () => {
    const a = await member('a@example.org');
    const b = await member('b@example.org');
    expect((await ctx.app.inject({ url: `/api/v1/portal/profiles/${b.id}`, headers: { cookie: a.pc } })).statusCode).toBe(404);
  });

  it('is part of the Art. 15 answer and goes with the person', async () => {
    const m = await member('weg@example.org');
    await m.call('PUT', '', full);
    await m.call('POST', '/photo', JPEG, { 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' });
    const exp = await ctx.app.inject({ url: `/api/v1/persons/${m.personId}/export`, headers: { cookie } });
    let text = '';
    for (let o = 0; exp.rawPayload.readUInt32LE(o) === 0x04034b50; ) {
      const size = exp.rawPayload.readUInt32LE(o + 18);
      const nameLen = exp.rawPayload.readUInt16LE(o + 26);
      const name = exp.rawPayload.subarray(o + 30, o + 30 + nameLen).toString();
      text += name + '\n' + (name.endsWith('.json') ? inflateRawSync(exp.rawPayload.subarray(o + 30 + nameLen, o + 30 + nameLen + size)).toString() : '');
      o += 30 + nameLen + size;
    }
    expect(text).toContain('Baut Agenten für Vereine.');
    expect(text).toContain('Profilfoto.jpeg');
    await admin.post(`/members/${m.id}/resign`, { noticeDate: '2020-09-01', exitDate: '2020-12-31' });
    expect((await admin.post(`/persons/${m.personId}/anonymise`, {})).status).toBe(200);
    expect(await ctx.db.selectFrom('member_profile').select('id').execute()).toEqual([]);
    expect(await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'photo').execute()).toEqual([]);
  });

  it('review fixes: own-access for adults in a household, photo removal is a new version, early size limit, uppercase scheme, read-only tokens', async () => {
    // A payer manages a child (no address) but not an adult with their own address.
    const payer = await member('zahler@example.org');
    const adult = (await admin.post('/members', { firstName: 'Ada', lastName: 'Erwachsen', email: 'ada@example.org', joinDate: '2015-01-01' })).body;
    const child = (await admin.post('/members', { firstName: 'Kim', lastName: 'Kind', birthDate: '2015-01-01', joinDate: '2020-01-01' })).body;
    await admin.post('/households', { name: 'Familie', payerPersonId: payer.personId, memberIds: [payer.id, adult.id, child.id] });
    const asPayer = (id: string) => ctx.app.inject({ url: `/api/v1/portal/profiles/${id}`, headers: { cookie: payer.pc } });
    expect((await asPayer(adult.id)).statusCode).toBe(403);
    expect((await asPayer(child.id)).statusCode).toBe(200);
    // Removing the photo of an approved profile takes it back to the board.
    await payer.call('PUT', '', full);
    await payer.call('POST', '/photo', JPEG, { 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' });
    await ctx.db.updateTable('member_profile').set({ approved_at: new Date() }).execute();
    expect((await payer.call('DELETE', '/photo', {})).json().approved).toBe(false);
    // Over 2 MB is refused while reading the body.
    const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await payer.call('POST', '/photo', big, { 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' })).statusCode).toBe(413);
    // An upper-case scheme is a valid address, in the API and in the database.
    expect((await payer.call('PUT', '', { ...full, links: [{ label: 'Web', url: 'HTTPS://petra.example' }] })).statusCode).toBe(200);
    // A read-only member token reads but does not write.
    const tok = (await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/tokens', headers: { cookie: payer.pc, 'content-type': 'application/json' }, payload: { name: 'Agent' } })).json().token as string;
    const viaToken = client(ctx.app, { token: tok });
    expect((await viaToken.get(`/portal/profiles/${payer.id}`)).status).toBe(200);
    expect((await viaToken.put(`/portal/profiles/${payer.id}`, full)).status).toBe(403);
    // The database keeps a profile to its own member's photo.
    const other = (await admin.post('/members', { lastName: 'Fremd', joinDate: '2020-01-01' })).body;
    const photo = await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'photo').executeTakeFirst();
    await payer.call('POST', '/photo', JPEG, { 'content-type': 'application/octet-stream', 'x-file-type': 'image/jpeg' });
    const own = (await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'photo').where('member_id', '=', payer.id).executeTakeFirstOrThrow()).id;
    await ctx.db.insertInto('member_profile').values({ organization_id: org, member_id: other.id }).execute();
    await expect(ctx.db.updateTable('member_profile').set({ photo_file_id: own }).where('member_id', '=', other.id).execute()).rejects.toThrow(/not a photo of member/);
    void photo;
  });
});
