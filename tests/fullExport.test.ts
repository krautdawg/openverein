import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

config.filesDir = await mkdtemp(join(tmpdir(), 'ov-export-'));
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
});

/** Reads every entry of a ZIP from our writer through the central directory. */
function unzip(buf: Buffer) {
  const out = new Map<string, Buffer>();
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    out.set(buf.subarray(o + 30, o + 30 + nameLen).toString(), inflateRawSync(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + size)));
    o += 30 + nameLen + size;
  }
  return out;
}

describe('full export', () => {
  it('exports everything with a manifest of hashes, decrypts bank details, drops credentials, and is admin-only', async () => {
    await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
    const m = (await admin.post('/members', { firstName: 'Eva', lastName: 'Export', email: 'eva@example.org', joinDate: '2024-01-01' })).body;
    await admin.post(`/members/${m.id}/mandates`, { signedOn: '2024-01-01', accountHolder: 'Eva Export', iban: 'DE02120300000000202051' });
    const inv = (await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 6000 }] })).body;
    await admin.post(`/invoices/${inv.id}/issue`, {});

    const treasurer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Kassenwart', null) });
    expect((await treasurer.post('/exports/full', {})).status).toBe(403);

    const run = await admin.post('/exports/full', {});
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const res = await ctx.app.inject({ url: `/api/v1/exports/full/${run.body.id}`, headers: { cookie } });
    const files = unzip(res.rawPayload);
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.schemaVersion).toBe('1');
    for (const [name, hash] of Object.entries(manifest.files)) expect(createHash('sha256').update(files.get(name)!).digest('hex')).toBe(hash);
    expect(manifest.counts.member).toBe(1);
    expect(manifest.counts.invoice).toBe(1);
    const mandate = JSON.parse(files.get('data/sepa_mandate.jsonl')!.toString().trim());
    expect(mandate.iban).toBe('DE02120300000000202051');
    expect(mandate).not.toHaveProperty('iban_hash');
    const users = files.get('data/app_user.jsonl')!.toString();
    expect(users).not.toContain('password_hash');
    expect(users).not.toContain('totp_secret');
    expect(files.has('data/session.jsonl')).toBe(false);
    expect(files.get('data/member.csv')!.toString()).toContain('membership_number');
    expect((await admin.get('/exports/full')).body).toHaveLength(1);
  });
});
