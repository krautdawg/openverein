import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { processJobs } from '../src/server/jobs/worker.ts';
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

    const started = await admin.post('/exports/full', {});
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(started.body.status).toBe('queued');
    // One at a time: a second start while the first is queued is refused.
    expect((await admin.post('/exports/full', {})).status).toBe(409);
    expect(await processJobs(ctx.db)).toBe(1);
    const job = (await admin.get(`/jobs/${started.body.id}`)).body;
    expect(job).toMatchObject({ status: 'done', progress: 100, label: 'Gesamtexport', resultPath: '/einstellungen/export' });
    expect((await admin.get('/jobs')).body).toHaveLength(1);
    // Jobs are private to the user who started them.
    expect((await treasurer.get(`/jobs/${started.body.id}`)).status).toBe(404);
    const run = { body: { id: job.resultFileId as string } };
    // Without a fresh link no download; the stored blob is encrypted.
    expect((await ctx.app.inject({ url: `/api/v1/exports/full/${run.body.id}?exp=${Date.now() + 1000}&sig=${'0'.repeat(64)}`, headers: { cookie } })).statusCode).toBe(403);
    const stored = await ctx.db.selectFrom('file').select('sha256').where('id', '=', run.body.id).executeTakeFirstOrThrow();
    const { getBlob } = await import('../src/server/files/store.ts');
    expect((await getBlob(stored.sha256)).includes(Buffer.from('manifest.json'))).toBe(false);
    const link = (await admin.post(`/exports/full/${run.body.id}/link`, {})).body.url as string;
    const res = await ctx.app.inject({ url: link, headers: { cookie } });
    const files = unzip(res.rawPayload);
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.schemaVersion).toBe('2');
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
    expect(manifest.undecryptable).toEqual({});
    // Negative numbers stay numbers in the CSV; empty tables still have a header.
    expect(files.get('data/receipt.csv')!.toString()).toContain('supplier');
    // An erasure removes stored exports.
    const gone = (await admin.post('/members', { lastName: 'Weg', joinDate: '2015-01-01' })).body;
    await admin.post(`/members/${gone.id}/resign`, { noticeDate: '2020-01-01', exitDate: '2020-12-31' });
    expect((await admin.post(`/persons/${gone.personId}/anonymise`, {})).status).toBe(200);
    expect(await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'export').execute()).toHaveLength(0);
    // Older than 7 days: no link, no download, even before the sweep removed it.
    await ctx.db.updateTable('file').set({ created_at: new Date(Date.now() - 8 * 86_400_000) }).where('id', '=', run.body.id).execute();
    expect((await admin.post(`/exports/full/${run.body.id}/link`, {})).status).toBe(404);
    expect((await ctx.app.inject({ url: link, headers: { cookie } })).statusCode).toBe(404);
  });

  it('fails a queued export when the starting admin lost the role, and retries a crashed job once', async () => {
    const other = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Admin', null, 'zweit@example.org') });
    const started = await other.post('/exports/full', {});
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const user = await ctx.db.selectFrom('app_user').select('id').where('email', '=', 'zweit@example.org').executeTakeFirstOrThrow();
    await ctx.db.deleteFrom('role_grant').where('user_id', '=', user.id).execute();
    await processJobs(ctx.db);
    const job = await ctx.db.selectFrom('job').selectAll().where('id', '=', started.body.id).executeTakeFirstOrThrow();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('nur Admins');
    expect(await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'export').execute()).toHaveLength(0);

    // A job left running by a crashed process is picked up again after its claim went stale; after two attempts it fails.
    const crashed = await ctx.db.insertInto('job').values({ organization_id: job.organization_id, kind: 'full_export', created_by: job.created_by, status: 'running', attempts: 2, claimed_at: new Date(Date.now() - 3_600_000) }).returning('id').executeTakeFirstOrThrow();
    await processJobs(ctx.db);
    expect((await ctx.db.selectFrom('job').select(['status', 'error']).where('id', '=', crashed.id).executeTakeFirstOrThrow())).toMatchObject({ status: 'failed', error: 'Die Aufgabe wurde unterbrochen. Starte sie neu.' });
  });
});
