import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { replayErasures } from '../src/server/gdpr/service.ts';
import { purgeTenant } from '../src/server/tenantPurge.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Findings of the second (Codex) review of group G16 (#89-#99). Each test failed on the code before the fix. */
const dir = await mkdtemp(join(tmpdir(), 'ov-g16b-'));
config.filesDir = dir;
const ctx = await testApp();
afterAll(() => {
  config.multiTenant = false;
  config.operatorToken = '';
  config.filesDir = dir;
  return ctx.close();
});

let admin: ReturnType<typeof client>;
let org: string;
beforeEach(async () => {
  await reset(ctx.db);
  config.filesDir = dir;
  await writeFile(join(dir, 'erasure-log.jsonl'), '');
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
});

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

describe('G16 second review', () => {
  it('writes the deletion intent before deleting a club, so a failed write deletes nothing', async () => {
    // The erasure log cannot be written (the files folder is a file).
    const blocked = join(dir, 'kein-ordner');
    await writeFile(blocked, 'x');
    config.filesDir = blocked;
    await expect(purgeTenant(ctx.db, org)).rejects.toThrow();
    config.filesDir = dir;
    expect(await ctx.db.selectFrom('organization').select('id').where('id', '=', org).executeTakeFirst()).toBeTruthy();
  });

  it('withdraws the intent when the deletion rolls back, so a restart does not repeat it', async () => {
    const user = await ctx.db.selectFrom('app_user').select('id').executeTakeFirstOrThrow();
    await sql`create schema ext16; create table ext16.link (user_id uuid references public.app_user (id)); insert into ext16.link values (${sql.lit(user.id)})`.execute(ctx.db);
    try {
      await expect(purgeTenant(ctx.db, org)).rejects.toThrow(/ext16/);
    } finally {
      await sql`drop schema ext16 cascade`.execute(ctx.db);
    }
    const lines = (await readFile(join(dir, 'erasure-log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { purge: boolean });
    expect(lines.map((l) => l.purge)).toEqual([true, false]);
    await replayErasures(ctx.db, { warn: () => undefined });
    expect(await ctx.db.selectFrom('organization').select('id').where('id', '=', org).executeTakeFirst()).toBeTruthy();
  });

  it('records the real before-values when the operator renames a club', async () => {
    config.multiTenant = true;
    config.operatorToken = 'o'.repeat(40);
    try {
      await ctx.db.updateTable('organization').set({ hostname: 'alt.example.org' }).where('id', '=', org).execute();
      const r = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/operator/tenants/${org}`, headers: { 'x-operator-token': config.operatorToken }, payload: { hostname: 'neu.example.org' } });
      expect(r.statusCode, r.body).toBe(200);
      const ev = await ctx.db.selectFrom('audit_event').select('diff').where('action', '=', 'organization.operator_updated').executeTakeFirstOrThrow();
      expect(ev.diff).toEqual({ hostname: ['alt.example.org', 'neu.example.org'] });
    } finally {
      config.multiTenant = false;
      config.operatorToken = '';
    }
  });

  it('refuses an offline attendance mark when someone corrected it meanwhile, and accepts the same status again', async () => {
    const calendarId = (await admin.post('/calendars', { name: 'Training', color: 'gruen' })).body.id;
    const d = past(1);
    const ev = (await admin.post('/events', { calendarId, title: 'Training', startsAt: `${d}T10:00`, endsAt: `${d}T12:00` })).body;
    const m = (await admin.post('/members', { lastName: 'Turner', joinDate: '2024-01-01' })).body.id;
    const url = `/events/${ev.eventId}/occurrences/${d}/participants/${m}`;
    // Trainer A sees no mark yet and goes offline; trainer B marks "not attended" online.
    expect((await admin.put(url, { status: 'not_attended' })).status).toBe(200);
    expect((await admin.put(url, { status: 'attended', baseUpdatedAt: null })).status).toBe(409);
    // A repeated mark that already arrived is fine.
    expect((await admin.put(url, { status: 'not_attended', baseUpdatedAt: null })).status).toBe(200);
    void future;
  });
});
