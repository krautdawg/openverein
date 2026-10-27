import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { decryptBytes } from '../src/server/crypto.ts';
import { getBlob } from '../src/server/files/store.ts';
import { processJobs } from '../src/server/jobs/worker.ts';
import { unpostedPayments } from '../src/server/ledger/service.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/**
 * Guards that review fixes added without a test of their own (docs/test-debt.md). Each test here failed on the code
 * before its fix; how that was checked is written next to it in test-debt.md.
 */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-debt-'));
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
let org: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt', iban: 'DE89370400440532013000' });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function unzip(buf: Buffer) {
  const out = new Map<string, Buffer>();
  for (let o = 0; buf.readUInt32LE(o) === 0x04034b50;) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const start = o + 30 + nameLen + buf.readUInt16LE(o + 28);
    out.set(buf.subarray(o + 30, o + 30 + nameLen).toString(), inflateRawSync(buf.subarray(start, start + size)));
    o = start + size;
  }
  return out;
}
/** Runs SQL around a test and always removes it again (test-only triggers). */
async function withSql<T>(setup: string, teardown: string, fn: () => Promise<T>) {
  await sql.raw(setup).execute(ctx.db);
  try {
    return await fn();
  } finally {
    await sql.raw(teardown).execute(ctx.db);
  }
}

describe('G8 guards', () => {
  it('job lease: a run whose job was reclaimed meanwhile stores no result', async () => {
    const started = await admin.post('/exports/full', {});
    expect(started.status).toBe(202);
    // Another worker reclaims the job (attempts + 1) as soon as this run reports progress.
    await withSql(
      `create function debt_reclaim() returns trigger language plpgsql as $$ begin if new.progress > 0 and old.progress = 0 then new.attempts := old.attempts + 1; end if; return new; end $$;
       create trigger debt_reclaim before update on job for each row execute function debt_reclaim();`,
      'drop trigger debt_reclaim on job; drop function debt_reclaim();',
      () => processJobs(ctx.db),
    );
    expect(await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'export').execute()).toEqual([]);
    expect((await ctx.db.selectFrom('job').select('status').executeTakeFirstOrThrow()).status).not.toBe('done');
  });

  it('export vs erasure: a person erased after the snapshot keeps the export from being stored', async () => {
    const m = (await admin.post('/members', { firstName: 'Erik', lastName: 'Erased', joinDate: '2020-01-01' })).body;
    expect((await admin.post('/exports/full', {})).status).toBe(202);
    // The erasure commits while the export runs; its time is set far back, as a long transaction's start would be.
    await withSql(
      `create function debt_erase() returns trigger language plpgsql as $$ begin
         if new.progress > 0 and old.progress = 0 then insert into erasure_log (organization_id, person_id, at) values (new.organization_id, '${m.personId}', '2000-01-01'); end if;
         return new; end $$;
       create trigger debt_erase after update on job for each row execute function debt_erase();`,
      'drop trigger debt_erase on job; drop function debt_erase();',
      () => processJobs(ctx.db),
    );
    expect(await ctx.db.selectFrom('file').select('id').where('purpose', '=', 'export').execute()).toEqual([]);
    expect((await ctx.db.selectFrom('job').select(['status', 'error']).executeTakeFirstOrThrow()).error).toContain('anonymisiert');
  });

  it('period lock: a payment reversed before it was ever posted still counts as unposted', async () => {
    const m = (await admin.post('/members', { firstName: 'Paul', lastName: 'Payer', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2020-01-01' })).body;
    const inv = (await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 5000 }] })).body;
    await admin.post(`/invoices/${inv.id}/issue`, { issueDate: '2026-01-02' });
    await ctx.db.insertInto('allocation').values({ organization_id: org, invoice_id: inv.id, amount_cents: 5000, booked_on: '2026-01-10', method: 'cash', note: null, created_by: null, created_at: new Date(), status: 'reversed', reversed_at: new Date() }).execute();
    expect(await unpostedPayments(ctx.db, org, null, '2026-01-31')).toBe(1);
  });
});

describe('G9 guards', () => {
  it('bulk job: a retry after the changes were committed returns the stored result and changes nothing', async () => {
    const group = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const m = (await admin.post('/members', { lastName: 'Bulk', joinDate: '2020-01-01' })).body.id;
    const user = (await admin.get('/auth/me')).body.id;
    await ctx.db.insertInto('job').values({ organization_id: org, kind: 'member_bulk', created_by: user, params: JSON.stringify({ ids: [m], action: 'add_to_group', groupId: group, date: '2026-01-01' }), result: JSON.stringify({ succeeded: 1, skipped: [] }) }).execute();
    expect(await processJobs(ctx.db)).toBe(1);
    expect(await ctx.db.selectFrom('group_membership').select('id').where('member_id', '=', m).where('group_id', '=', group).execute()).toEqual([]);
  });

  it('bulk scope: a membership ended while the bulk action runs is not used as a right', async () => {
    const tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const target = (await admin.post('/groups', { name: 'Kurs', shortCode: 'KUR' })).body.id;
    const m = (await admin.post('/members', { lastName: 'Scope', joinDate: '2020-01-01', groupIds: [tennis] })).body.id;
    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Abteilungsleitung', [tennis, target]) });
    const gm = (await ctx.db.selectFrom('group_membership').select('id').where('member_id', '=', m).where('group_id', '=', tennis).executeTakeFirstOrThrow()).id;
    // Another admin ends the Tennis membership in a transaction still open while the lead's bulk action runs.
    const ending = ctx.db.transaction().execute(async (tx) => {
      await tx.updateTable('group_membership').set({ valid_to: '2020-06-30' }).where('id', '=', gm).execute();
      await sleep(300);
    });
    await sleep(50);
    const bulk = lead.post('/members/bulk', { ids: [m], action: 'add_to_group', groupId: target, date: '2026-01-01' });
    await ending;
    const r = await bulk;
    expect(r.body.succeeded ?? r.body.result?.succeeded).toBe(0);
    expect(await ctx.db.selectFrom('group_membership').select('id').where('member_id', '=', m).where('group_id', '=', target).execute()).toEqual([]);
  });
});

describe('G10 guards', () => {
  it('expense claim: one dated in the future is not approved', async () => {
    const m = (await admin.post('/members', { firstName: 'Ella', lastName: 'Expense', joinDate: '2020-01-01' })).body;
    const file = await ctx.db.insertInto('file').values({ organization_id: org, folder_id: null, member_id: null, purpose: 'receipt', sha256: 'a'.repeat(64), size_bytes: 1, mime_type: 'application/pdf', name: 'beleg.pdf', retention_class: 'voucher', retain_until: '2035-12-31', uploaded_by: null }).returning('id').executeTakeFirstOrThrow();
    const claim = await ctx.db.insertInto('expense_claim').values({ organization_id: org, member_id: m.id, person_id: m.personId, purpose: 'Bälle', spent_on: '2099-01-01', amount_cents: 1000, account_holder: 'Ella', iban_encrypted: 'x', file_id: file.id }).returning('id').executeTakeFirstOrThrow();
    const accounts = (await admin.get('/ledger/accounts')).body as { id: string; number: string }[];
    const r = await admin.post(`/expense-claims/${claim.id}/approve`, { accountId: accounts.find((a) => a.number === '6100')!.id });
    expect(r.status).toBe(409);
    expect(r.body.type).toMatch(/future-date$/);
  });

  it('assembly: two invitations at once send one', async () => {
    await admin.post('/members', { firstName: 'Ina', lastName: 'Invite', email: 'ina@example.org', joinDate: '2020-01-01' });
    const held = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const a = (await admin.post('/assemblies', { title: 'Mitgliederversammlung', heldOn: held, startsAt: '19:00', place: 'Vereinsheim', noticeDays: 14, items: [{ title: 'Bericht' }] })).body;
    // The first invitation's transaction pauses after creating its message, so the second arrives meanwhile.
    const both = await withSql(
      `create function debt_slow() returns trigger language plpgsql as $$ begin perform pg_sleep(0.3); return new; end $$;
       create trigger debt_slow after insert on message for each row execute function debt_slow();`,
      'drop trigger debt_slow on message; drop function debt_slow();',
      () => Promise.all([admin.post(`/assemblies/${a.id}/invite`, {}), sleep(50).then(() => admin.post(`/assemblies/${a.id}/invite`, {}))]),
    );
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ctx.db.selectFrom('message').select('id').execute()).toHaveLength(1);
  });

  it('work hours: hours being logged while the year is settled count before the invoice', async () => {
    await admin.put('/work-hours/settings', { fromYear: 2025, required: 10, rateCents: 1500, ageFrom: null, ageTo: null });
    const m = (await admin.post('/members', { lastName: 'Fleissig', birthDate: '1980-01-01', joinDate: '2020-01-01' })).body.id;
    const user = (await admin.get('/auth/me')).body.id;
    // A division lead logs the missing 10 hours; that transaction is still open when the settlement starts.
    const logging = ctx.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`work-hours:${m}:2025`}))`.execute(tx);
      await tx.insertInto('work_hour_entry').values({ organization_id: org, member_id: m, worked_on: '2025-06-01', hours: '10', text: 'Platzpflege', logged_by: user }).execute();
      await sleep(300);
    });
    await sleep(50);
    const settle = admin.post('/work-hours/settle', { year: 2025 });
    await logging;
    expect((await settle).body).toMatchObject({ drafted: 0 });
    expect(await ctx.db.selectFrom('invoice').select('id').execute()).toEqual([]);
  });
});

describe('G12 guards', () => {
  it('full export: poll answers come without the voter', async () => {
    const m = (await admin.post('/members', { firstName: 'Vera', lastName: 'Voter', joinDate: '2020-01-01' })).body.id;
    const poll = await ctx.db.insertInto('poll').values({ organization_id: org, question: 'Sommerfest?', description: null, options: ['Ja', 'Nein'], group_id: null, closes_on: '2026-12-31', created_by: null }).returning('id').executeTakeFirstOrThrow();
    await ctx.db.insertInto('poll_vote').values({ poll_id: poll.id, member_id: m, choices: [0] }).execute();
    expect((await admin.post('/exports/full', {})).status).toBe(202);
    await processJobs(ctx.db);
    const f = await ctx.db.selectFrom('file').select('sha256').where('purpose', '=', 'export').executeTakeFirstOrThrow();
    const votes = unzip(decryptBytes(await getBlob(f.sha256))).get('data/poll_vote.jsonl')!.toString().trim();
    expect(JSON.parse(votes)).toMatchObject({ choices: [0] });
    expect(votes).not.toContain('member_id');
    expect(votes).not.toContain(m);
  });

  it('treasurer report: the public demo prints its watermark', async () => {
    await ctx.db.updateTable('organization').set({ is_demo: true }).execute();
    const pdf = (await ctx.app.inject({ url: '/api/v1/ledger/reports/treasurer.pdf?year=2026', headers: { cookie } })).rawPayload.toString('latin1');
    // The watermark's colour (#f2c230) in any content stream.
    const streams = [...pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((x) => {
      try {
        return inflateSync(Buffer.from(x[1]!, 'latin1')).toString('latin1');
      } catch {
        return '';
      }
    });
    expect(streams.some((s) => /0\.949\d* 0\.76\d* 0\.188\d* (rg|sc)/.test(s))).toBe(true);
  });
});

describe('G17 guards', () => {
  // Passes on the old trigger (0064) too: PostgreSQL waits for the archiving transaction and re-checks the row
  // either way (see docs/test-debt.md). Kept as the behaviour check for the lock-first form of 0071.
  it('archived person: an insert waits for a running archive even without a foreign key to wait on', async () => {
    const m = (await admin.post('/members', { firstName: 'Rita', lastName: 'Race', joinDate: '2020-01-01' })).body;
    // A table with the guard but no foreign key: nothing else makes the insert wait for the archiving transaction.
    await withSql(
      `create table debt_guarded (person_id uuid);
       create trigger debt_guarded before insert on debt_guarded for each row execute function ov_person_not_archived('person_id');`,
      'drop table debt_guarded;',
      async () => {
        const archiving = ctx.db.transaction().execute(async (tx) => {
          await tx.selectFrom('person').select('id').where('id', '=', m.personId).forUpdate().execute();
          await tx.updateTable('person').set({ status: 'archived' }).where('id', '=', m.personId).execute();
          await sleep(300);
        });
        await sleep(50);
        const insert = sql`insert into debt_guarded values (${m.personId}::uuid)`.execute(ctx.db);
        const refused = expect(insert).rejects.toThrow(/archived/);
        await archiving;
        await refused;
      },
    );
  });
});
