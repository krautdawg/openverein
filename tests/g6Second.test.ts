import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { anonymise, replayErasures } from '../src/server/gdpr/service.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/** Findings of the second (Codex) review of group G6 (#15-#18). Each test failed on the code before the fix. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-g6b-'));
const ctx = await testApp();
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const accounts = async () => {
  const list = (await admin.get('/ledger/accounts')).body as { id: string; number: string }[];
  return (n: string) => list.find((a) => a.number === n)!.id;
};
const donor = { lastName: 'Spender', firstName: 'Sina', street: 'Weg 3', postalCode: '12345', city: 'Musterstadt' };
const settings = { kind: 'freistellung', office: 'Musterstadt', taxNumber: '12/345/67890', date: `${new Date().getFullYear() - 1}-05-01`, period: '2021–2023', purposes: 'des Sports (§ 52 Abs. 2 Satz 1 Nr. 21 AO)', signer: 'Erika Mustermann, Kassenwartin' };

async function formerMember(lastName: string) {
  const m = (await admin.post('/members', { lastName, firstName: 'Paula', email: `${lastName.toLowerCase()}@example.org`, joinDate: '2015-01-01' })).body;
  await admin.post(`/members/${m.id}/resign`, { noticeDate: '2020-09-01', exitDate: '2020-12-31' });
  return m as { id: string; personId: string };
}

describe('G6 second review', () => {
  it('replays an idempotent answer only while the caller still has the right', async () => {
    const roles = (await admin.get('/roles')).body as { id: string; name: string; permissions: Record<string, string> }[];
    await admin.post('/roles', { name: 'Rechnungen', permissions: { ...Object.fromEntries(Object.keys(roles[0]!.permissions).map((k) => [k, 'read'])), invoices: 'write', members: 'write' } });
    const userCookie = await userWithRole(ctx.app, cookie, 'Rechnungen');
    const m = (await admin.post('/members', { lastName: 'Rechnung', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2020-01-01' })).body;
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { cookie: userCookie, 'idempotency-key': 'replay-key-001' }, payload: { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 100 }] } });
    expect((await send()).statusCode).toBe(201);
    // The role loses invoice rights; the stored answer is not handed out any more.
    const role = (await admin.get('/roles')).body.find((r: { name: string }) => r.name === 'Rechnungen');
    await ctx.db.updateTable('role').set({ permissions: { ...role.permissions, invoices: 'read' } }).where('id', '=', role.id).execute();
    expect((await send()).statusCode).toBe(403);
  });

  it('keeps an anonymised person final: no new donation, no new consent', async () => {
    const m = await formerMember('Final');
    expect((await admin.post(`/persons/${m.personId}/anonymise`, {})).status).toBe(200);
    expect((await admin.post('/donations', { personId: m.personId, date: '2026-03-01', amountCents: 1000 })).status).toBe(409);
    await expect(ctx.db.insertInto('consent').values({ organization_id: org, person_id: m.personId, purpose: 'photos', source: 'paper' } as never).execute()).rejects.toThrow(/anonymised/);
  });

  it('does not start when an erasure cannot be repeated after a restore', async () => {
    const m = await formerMember('Replay');
    await writeFile(join(config.filesDir, 'erasure-log.jsonl'), JSON.stringify({ o: org, p: m.personId, at: new Date().toISOString() }) + '\n');
    // The re-anonymisation fails (a test trigger refuses the person update).
    await sql.raw(`create function debt_block() returns trigger language plpgsql as $$ begin raise exception 'blocked'; end $$;
      create trigger debt_block before update on person for each row execute function debt_block();`).execute(ctx.db);
    try {
      await expect(replayErasures(ctx.db, { warn: () => undefined })).rejects.toThrow(/nicht wiederholen/);
    } finally {
      await sql.raw('drop trigger debt_block on person; drop function debt_block();').execute(ctx.db);
    }
  });

  it('refuses a legal hold that arrives while the person is being anonymised', async () => {
    const m = await formerMember('Hold');
    const erasing = ctx.db.transaction().execute(async (tx) => {
      await anonymise(tx, org, m.personId);
      await sleep(300);
    });
    await sleep(50);
    const hold = admin.put(`/persons/${m.personId}/legal-hold`, { reason: 'Rechtsstreit' });
    await erasing;
    expect((await hold).status).toBe(409);
  });

  it('books a donation in the sphere of its income account, and gives no receipt for economic income', async () => {
    const acc = await accounts();
    await admin.put('/donations/settings', settings);
    const d = (await admin.post('/donations', { donor, date: '2026-03-01', amountCents: 50000, moneyAccountId: acc('1100'), incomeAccountId: acc('4600') })).body;
    const lines = await ctx.db.selectFrom('journal_line').innerJoin('donation', 'donation.journal_entry_id', 'journal_line.entry_id').select('journal_line.sphere').where('donation.id', '=', d.id).execute();
    expect(lines.map((l) => l.sphere)).toEqual(['wirtschaft', 'wirtschaft']);
    expect((await admin.post('/donation-receipts', { personId: d.personId, donationIds: [d.id] })).status).toBe(400);
  });

  it('never deletes a donation', async () => {
    const d = (await admin.post('/donations', { donor, date: '2026-03-01', amountCents: 1000 })).body;
    await expect(ctx.db.deleteFrom('donation').where('id', '=', d.id).execute()).rejects.toThrow(/voided, not deleted/);
  });

  it('needs an idempotency key for reversals, and keeps DATEV exports unchanged', async () => {
    const acc = await accounts();
    const b = (await admin.post('/ledger/bookings', { kind: 'income', date: '2026-03-01', text: 'Bank', moneyAccountId: acc('1100'), lines: [{ grossCents: 1000, accountId: acc('4100') }] })).body;
    const noKey = await ctx.app.inject({ method: 'POST', url: `/api/v1/ledger/entries/${b.id}/reverse`, headers: { cookie, 'content-type': 'application/json' }, payload: {} });
    expect(noKey.statusCode).toBe(400);
    await admin.put('/ledger/datev-settings', { consultant: 1001, client: 1, accountLength: 4, fiscalYearStartMonth: 1 });
    await admin.patch(`/ledger/accounts/${acc('1100')}`, { datevNumber: '1800' });
    await admin.patch(`/ledger/accounts/${acc('4100')}`, { datevNumber: '2250' });
    const exp = await admin.post('/ledger/exports/datev', { from: '2026-01-01', to: '2026-03-31' });
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    await expect(ctx.db.updateTable('datev_export').set({ sha256: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(ctx.db.deleteFrom('datev_export_entry').execute()).rejects.toThrow(/append-only/);
  });

  it('puts every person-linked table into the Art. 15 answer (or names why not), with the stored files', async () => {
    const { ART15_TABLES, ART15_NOT_EXPORTED } = await import('../src/server/routes/privacy.ts');
    const linked = (await sql<{ t: string }>`select distinct table_name as t from information_schema.columns where table_schema = 'public' and column_name in ('person_id', 'member_id', 'recipient_person_id', 'payer_person_id')`.execute(ctx.db)).rows.map((r) => r.t);
    expect(linked.filter((t) => !ART15_TABLES.includes(t) && !(t in ART15_NOT_EXPORTED))).toEqual([]);

    const m = (await admin.post('/members', { lastName: 'Akte', joinDate: '2020-01-01' })).body;
    const up = await ctx.app.inject({ method: 'POST', url: `/api/v1/files?memberId=${m.id}`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': 'attest.pdf' }, payload: Buffer.from('%PDF-1.4 Attest') });
    expect(up.statusCode).toBe(201);
    const res = await ctx.app.inject({ url: `/api/v1/persons/${m.personId}/export`, headers: { cookie } });
    expect(res.rawPayload.includes(Buffer.from('dateien/attest.pdf'))).toBe(true);
  });
});
