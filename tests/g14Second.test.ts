import { inflateRawSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reverseEntry } from '../src/server/ledger/service.ts';
import { runGreetings } from '../src/server/members/greetings.ts';
import { orgToday } from '../src/server/members/query.ts';
import { runFeeSchedules } from '../src/server/routes/fees.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/** Findings of the second (Codex) review of group G14 (#69-#76). Each test failed on the code before the fix. */
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
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const german = (d: string) => d.split('-').reverse().join('.');
/** The text of every file in a ZIP from our writer (local headers in order). */
function unzipText(buf: Buffer) {
  let out = '';
  for (let o = 0; buf.readUInt32LE(o) === 0x04034b50; ) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    out += inflateRawSync(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + size)).toString();
    o += 30 + nameLen + size;
  }
  return out;
}
const accounts = async () => (await admin.get('/ledger/accounts')).body as { id: string; number: string; kind: string }[];

async function bankMovements(csvRows: string[]) {
  const accountId = (await admin.post('/bank-accounts', { name: 'Vereinskonto', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', openingDate: '2026-01-01', openingBalanceCents: 0 })).body.id;
  await admin.post(`/bank-accounts/${accountId}/imports`, { format: 'csv', content: ['Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag', ...csvRows].join('\n') });
  return (await admin.get('/bank-transactions')).body as { id: string; amountCents: number }[];
}

describe('G14 second review', () => {
  it('keeps tasks away from API keys', async () => {
    const role = ((await admin.get('/roles')).body as { id: string; name: string }[]).find((r) => r.name === 'Admin')!;
    const token = (await admin.post('/api-tokens', { name: 'Website', roleId: role.id })).body.token;
    const api = client(ctx.app, { token });
    expect((await api.get('/tasks')).status).toBe(400);
    expect((await api.get('/tasks/assignees')).status).toBe(400);
  });

  it('checks a task edit against the row as it is after a reassignment', async () => {
    const kasseCookie = await userWithRole(ctx.app, cookie, 'Kassenwart');
    const kasse = ((await admin.get('/tasks/assignees')).body as { id: string; name: string }[]).find((u) => u.name === 'Kassenwart Test')!;
    const me = ((await admin.get('/tasks/assignees')).body as { id: string; name: string }[]).find((u) => u.id !== kasse.id)!;
    const t = (await admin.post('/tasks', { title: 'Kasse prüfen', assigneeUserId: kasse.id })).body;
    // The creator hands the task to someone else; meanwhile the former assignee edits it.
    const reassign = ctx.db.transaction().execute(async (tx) => {
      await tx.selectFrom('task').select('id').where('id', '=', t.id).forUpdate().execute();
      await tx.updateTable('task').set({ assignee_user_id: me.id, created_by: me.id }).where('id', '=', t.id).execute();
      await sleep(300);
    });
    await sleep(50);
    const edit = client(ctx.app, { cookie: kasseCookie }).patch(`/tasks/${t.id}`, { title: 'Übernommen' });
    await reassign;
    expect((await edit).status).toBe(403);
  });

  it('does not book a bank movement dated in the future, and never reverses before the original', async () => {
    const today = await orgToday(ctx.db, org);
    const open = await bankMovements([`${german(addDays(today, 1))};Kontofuehrung;Bank;;-4,90`]);
    const expense = (await accounts()).find((a) => a.kind === 'expense')!.id;
    expect((await admin.post('/bank-transactions/book', { transactionIds: [open[0]!.id], accountId: expense })).status).toBe(409);
    const acc = await accounts();
    const b = (await admin.post('/ledger/bookings', { kind: 'income', date: today, text: 'Bar', moneyAccountId: acc.find((a) => a.number === '1100')!.id, lines: [{ grossCents: 1000, accountId: acc.find((a) => a.number === '4100')!.id }] })).body;
    await expect(ctx.db.transaction().execute((tx) => reverseEntry(tx, org, b.id, addDays(today, -1), null))).rejects.toThrow(/vor der Buchung/);
  });

  it('lets a treasurer without invoice rights undo their own bank booking', async () => {
    const roles = (await admin.get('/roles')).body as { permissions: Record<string, string> }[];
    await admin.post('/roles', { name: 'Bankbuchung', permissions: { ...Object.fromEntries(Object.keys(roles[0]!.permissions).map((k) => [k, 'read'])), banking: 'write', ledger: 'write' } });
    const user = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Bankbuchung') });
    const open = await bankMovements(['01.10.2026;Kontofuehrung;Bank;;-4,90']);
    const expense = (await accounts()).find((a) => a.kind === 'expense')!.id;
    const booked = await user.post('/bank-transactions/book', { transactionIds: [open[0]!.id], accountId: expense });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    const undo = await user.post(`/bank-transactions/${open[0]!.id}/unmatch`, {});
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
  });

  it('erases offer drafts with the person, exports them before, and converts nothing for an anonymised person', async () => {
    const m = (await admin.post('/members', { lastName: 'Angebot', firstName: 'Anna', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2015-01-01' })).body;
    await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
    const draft = (await admin.post('/offers', { memberId: m.id, coverText: 'Liebe Anna, wegen Deiner Knie-OP …', lines: [{ text: 'Reha-Kurs', unitCents: 5000 }] })).body;
    expect(draft.id).toBeTruthy();
    const sent = (await admin.post('/offers', { memberId: m.id, lines: [{ text: 'Platzmiete', unitCents: 2000 }] })).body;
    expect((await admin.post(`/offers/${sent.id}/issue`, {})).status).toBe(200);
    expect((await admin.post(`/offers/${sent.id}/accept`, {})).status).toBe(200);
    const exp = await ctx.app.inject({ url: `/api/v1/persons/${m.personId}/export`, headers: { cookie } });
    expect(unzipText(exp.rawPayload)).toContain('Knie-OP');
    await admin.post(`/members/${m.id}/resign`, { noticeDate: '2020-09-01', exitDate: '2020-12-31' });
    expect((await admin.post(`/persons/${m.personId}/anonymise`, {})).status).toBe(200);
    expect(await ctx.db.selectFrom('offer').select('id').where('id', '=', draft.id).executeTakeFirst()).toBeUndefined();
    expect((await admin.post(`/offers/${sent.id}/convert`, {})).status).toBe(409);
  });

  it('posts no tax to a retired tax account', async () => {
    const [created, active] = (await accounts()).filter((a) => a.kind === 'tax');
    expect((await admin.patch(`/ledger/accounts/${created!.id}`, { retired: true })).status).toBe(200);
    expect((await admin.post('/ledger/tax-rates', { label: 'Alt 7 %', rateBp: 700, validFrom: '2026-01-01', outputAccountId: created!.id })).status).toBe(400);
    // A rate set up before the account was retired.
    const rate = (await admin.post('/ledger/tax-rates', { label: 'Neu 7 %', rateBp: 700, validFrom: '2026-01-01', outputAccountId: active!.id })).body;
    expect((await admin.patch(`/ledger/accounts/${active!.id}`, { retired: true })).status).toBe(200);
    const acc = await accounts();
    const r = await admin.post('/ledger/bookings', { kind: 'income', date: '2026-03-01', text: 'Verkauf', moneyAccountId: acc.find((a) => a.number === '1100')!.id, lines: [{ grossCents: 1070, accountId: acc.find((a) => a.number === '4100')!.id, taxRateId: rate.id }] });
    expect(r.status).toBe(409);
  });

  it('sends no greeting mail to someone who wants letters', async () => {
    const today = await orgToday(ctx.db, org);
    const year = Number(today.slice(0, 4));
    const m = (await admin.post('/members', { firstName: 'Lotte', lastName: 'Brief', email: 'lotte@example.org', birthDate: `${year - 30}${today.slice(4)}`, joinDate: `${year - 25}${today.slice(4)}` })).body;
    await ctx.db.updateTable('person').set({ preferred_channel: 'letter' }).where('id', '=', m.personId).execute();
    await admin.patch('/organization', { birthdayGreetings: 'round', anniversaryGreetings: true });
    expect(await runGreetings(ctx.db)).toBe(0);
  });

  it('gives the month back when the scheduled preview fails on a passing fault', async () => {
    const plan = (await admin.post('/fee-plans', { name: 'Beitrag', version: { validFrom: '2020-01-01', amountCents: 6000, intervalMonths: 12 } })).body.id;
    const m = (await admin.post('/members', { lastName: 'Zahler', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2026-01-01' })).body;
    await admin.post(`/members/${m.id}/fee-assignments`, { feePlanId: plan, validFrom: '2026-01-01' });
    expect((await admin.put('/fee-schedule', { day: 1, leadDays: 30 })).status).toBe(200);
    await sql.raw(`create function debt_block() returns trigger language plpgsql as $$ begin raise exception 'blocked'; end $$;
      create trigger debt_block before insert on fee_run for each row execute function debt_block();`).execute(ctx.db);
    try {
      expect(await runFeeSchedules(ctx.db)).toBe(0);
    } finally {
      await sql.raw('drop trigger debt_block on fee_run; drop function debt_block();').execute(ctx.db);
    }
    expect(await runFeeSchedules(ctx.db)).toBe(1);
  });
});
