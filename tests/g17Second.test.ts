import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { encrypt } from '../src/server/crypto.ts';
import { addBusinessDays } from '../src/server/sepa/pain.ts';
import { assertWebhookTarget, isPrivateAddress } from '../src/server/webhooks/worker.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/** Findings of the second (Codex) review of group G17 (#100-#112). Each test failed on the code before the fix. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-g17b-'));
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
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

/** The text of every file in a ZIP from our writer, and the file names. */
function unzip(buf: Buffer) {
  let text = '';
  const names: string[] = [];
  for (let o = 0; buf.readUInt32LE(o) === 0x04034b50; ) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    names.push(buf.subarray(o + 30, o + 30 + nameLen).toString());
    text += inflateRawSync(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + size)).toString('latin1');
    o += 30 + nameLen + size;
  }
  return { text, names };
}

describe('G17 second review', () => {
  it('blocks IPv6 forms that carry an IPv4 address (mapped in any spelling, compatible, 6to4, Teredo)', () => {
    expect(isPrivateAddress('::7f00:1')).toBe(true);
    expect(isPrivateAddress('2002:7f00:1::')).toBe(true);
    expect(isPrivateAddress('2001:0:4136:e378::1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('0:0:0:0:0:ffff:a00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:808:808')).toBe(false);
    expect(() => assertWebhookTarget('https://[::ffff:127.0.0.1]/hook')).toThrow(/privaten Netz/);
  });

  it('does not debit an invoice that was issued for bank transfer', async () => {
    await admin.patch('/organization', { creditorId: 'DE98ZZZ09999999999', prenotificationDays: 1 });
    const accountId = (await admin.post('/bank-accounts', { name: 'Vereinskonto', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', openingDate: '2026-01-01', openingBalanceCents: 0 })).body.id;
    const m = (await admin.post('/members', { lastName: 'Wechsel', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2020-01-01' })).body.id;
    await admin.patch(`/members/${m}/payment-method`, { paymentMethod: 'transfer' });
    const inv = (await admin.post('/invoices', { memberId: m, dueDate: today(), lines: [{ text: 'Beitrag', unitCents: 5000 }] })).body;
    await admin.post(`/invoices/${inv.id}/issue`, {});
    // Later the member switches to direct debit: the old invoice announced a transfer, so it is not collected.
    await admin.patch(`/members/${m}/payment-method`, { paymentMethod: 'direct_debit' });
    await admin.post(`/members/${m}/mandates`, { signedOn: '2024-01-15', accountHolder: 'Wim Wechsel', iban: 'DE02120300000000202051' });
    const r = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: addBusinessDays(today(), 5), invoiceIds: [inv.id] });
    // Already guarded before this review (the invoice must have announced this mandate): this test pins it.
    expect(r.status).toBe(409);
    expect(r.body.type).toMatch(/not-ready$/);
  });

  it('replays a stored money answer only to unchanged rights', async () => {
    const roles = (await admin.get('/roles')).body as { id: string; name: string; permissions: Record<string, string> }[];
    await admin.post('/roles', { name: 'Rechnungen', permissions: { ...Object.fromEntries(Object.keys(roles[0]!.permissions).map((k) => [k, 'read'])), invoices: 'write', members: 'write' } });
    const userCookie = await userWithRole(ctx.app, cookie, 'Rechnungen');
    const m = (await admin.post('/members', { lastName: 'Rechnung', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2020-01-01' })).body;
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { cookie: userCookie, 'idempotency-key': 'replay-key-g17' }, payload: { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 100 }] } });
    expect((await send()).statusCode).toBe(201);
    // The role is narrowed (members only readable now); invoice writing stays, but the stored answer is not handed out.
    const role = (await admin.get('/roles')).body.find((r: { name: string }) => r.name === 'Rechnungen');
    await ctx.db.updateTable('role').set({ permissions: { ...role.permissions, members: 'read' } }).where('id', '=', role.id).execute();
    const again = await send();
    expect(again.statusCode).toBe(409);
    expect(again.body).not.toContain('Beitrag');
  });

  it('gives the person their stored data in Art. 15, but never their ballot', async () => {
    const m = (await admin.post('/members', { lastName: 'Auskunft', firstName: 'Ada', email: 'ada@example.org', joinDate: '2020-01-01' })).body;
    await admin.post(`/members/${m.id}/mandates`, { signedOn: '2024-01-15', accountHolder: 'Ada Auskunft', iban: 'DE02120300000000202051' });
    const file = await ctx.db.insertInto('file').values({ organization_id: org, folder_id: null, member_id: null, purpose: 'receipt', sha256: 'c'.repeat(64), size_bytes: 1, mime_type: 'application/pdf', name: 'kassenbon-sentinel.pdf', retention_class: 'voucher', retain_until: '2035-12-31', uploaded_by: null }).returning('id').executeTakeFirstOrThrow();
    const { putBlob } = await import('../src/server/files/store.ts');
    const sha = await putBlob(Buffer.from('bon'));
    await ctx.db.updateTable('file').set({ sha256: sha }).where('id', '=', file.id).execute();
    await ctx.db.insertInto('expense_claim').values({ organization_id: org, member_id: m.id, person_id: m.personId, purpose: 'Bälle', spent_on: '2026-03-01', amount_cents: 1000, account_holder: 'Ada Auskunft', iban_encrypted: encrypt('DE89370400440532013000'), file_id: file.id }).execute();
    const poll = await ctx.db.insertInto('poll').values({ organization_id: org, question: 'Sommerfest?', options: ['Ja-Sentinel', 'Nein-Sentinel'], closes_on: '2026-12-31' }).returning('id').executeTakeFirstOrThrow();
    await ctx.db.insertInto('poll_vote').values({ poll_id: poll.id, member_id: m.id, choices: [1] }).execute();
    const res = await ctx.app.inject({ url: `/api/v1/persons/${m.personId}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { text, names } = unzip(res.rawPayload);
    expect(text).toContain('DE02120300000000202051'); // mandate IBAN in clear
    expect(text).toContain('DE89370400440532013000'); // payout IBAN of the claim
    expect(names).toContain('dateien/kassenbon-sentinel.pdf');
    expect(text).toContain('Sommerfest?');
    expect(text).not.toMatch(/"Antwort"/);
  });

  it('settles work hours from the member as it is when the settlement runs', async () => {
    await admin.put('/work-hours/settings', { fromYear: 2025, required: 10, rateCents: 1500, ageFrom: 18, ageTo: 65 });
    const m = (await admin.post('/members', { lastName: 'Stunde', firstName: 'Sam', birthDate: '1990-01-01', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2020-01-01' })).body;
    // Someone corrects the birth date (a child, so no hours owed) while the settlement runs.
    const fix = ctx.db.transaction().execute(async (tx) => {
      await tx.updateTable('person').set({ birth_date: '2015-01-01' }).where('id', '=', m.personId).execute();
      await sleep(300);
    });
    await sleep(50);
    const settle = admin.post('/work-hours/settle', { year: 2025 });
    await fix;
    const r = await settle;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.drafted).toBe(0);
  });
});
