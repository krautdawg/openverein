import { sql } from 'kysely';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { replayErasures } from '../src/server/gdpr/service.ts';
import { config } from '../src/server/config.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

config.filesDir = await mkdtemp(join(tmpdir(), 'ov-privacy-'));
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
});

const formerMember = async (lastName = 'Zahler') => {
  const m = (await admin.post('/members', { lastName, firstName: 'Paula', email: `${lastName.toLowerCase()}@example.org`, street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2015-01-01' })).body;
  return (await admin.post(`/members/${m.id}/resign`, { noticeDate: '2020-09-01', exitDate: '2020-12-31' })).body;
};

describe('privacy', () => {
  it('records consent and its withdrawal, which unsubscribes from the newsletter', async () => {
    const m = await formerMember();
    const c = await admin.post(`/persons/${m.personId}/consents`, { purpose: 'newsletter', source: 'paper', textVersion: 'Aufnahmeantrag 2024' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await admin.post(`/persons/${m.personId}/consents`, { purpose: 'newsletter', source: 'paper' })).status).toBe(409); // one live consent per purpose
    expect((await admin.post(`/consents/${c.body.id}/withdraw`, { source: 'portal' })).body.withdrawnSource).toBe('portal');
    expect(await ctx.db.selectFrom('suppression').select('reason').execute()).toEqual([{ reason: 'unsubscribe' }]);
    // A new opt-in does not silently lift an unsubscribe (the address may be shared).
    await admin.post(`/persons/${m.personId}/consents`, { purpose: 'newsletter', source: 'form' });
    expect(await ctx.db.selectFrom('suppression').select('reason').execute()).toEqual([{ reason: 'unsubscribe' }]);
  });

  it('refuses to anonymise with open items or a hold, then anonymises, keeps the invoice snapshot and survives a restore', async () => {
    const m = await formerMember();
    expect(m.status, JSON.stringify(m)).toBe('former');
    const inv = (await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 6000 }] })).body;
    await admin.post(`/invoices/${inv.id}/issue`, {});
    const blocked = await admin.post(`/persons/${m.personId}/anonymise`, {});
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(blocked.body.blockers.join(' ')).toMatch(/Rechnung .* ist noch offen/);
    await admin.post(`/invoices/${inv.id}/payments`, { amountCents: 6000, bookedOn: '2026-01-05', method: 'cash' });
    await admin.put(`/persons/${m.personId}/legal-hold`, { reason: 'Rechtsstreit Hallenschaden' });
    expect((await admin.post(`/persons/${m.personId}/anonymise`, {})).body.blockers).toEqual(['Löschsperre: Rechtsstreit Hallenschaden']);
    await admin.put(`/persons/${m.personId}/legal-hold`, { reason: null });

    // Roadmap S20: anonymising leaves the books as they were (EÜR and journal totals).
    const books = async () => ({
      euer: (await admin.get('/ledger/reports/euer?from=2026-01-01&to=2026-12-31')).body,
      journal: await ctx.db.selectFrom('journal_line').select([sql<string>`sum(debit_cents)`.as('d'), sql<string>`sum(credit_cents)`.as('c'), sql<number>`count(*)::int`.as('n')]).executeTakeFirstOrThrow(),
    });
    const before = await books();
    expect(before.journal.n).toBeGreaterThan(0);
    const done = await admin.post(`/persons/${m.personId}/anonymise`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await books()).toEqual(before);
    const p = await ctx.db.selectFrom('person').selectAll().where('id', '=', m.personId).executeTakeFirstOrThrow();
    expect([p.first_name, p.last_name, p.email, p.street]).toEqual([null, 'Anonymisiert', null, null]);
    // Audit entries about the person keep the action, not the values.
    const diffs = await ctx.db.selectFrom('audit_event').select('diff').where('entity_id', 'in', [m.personId, m.id]).execute();
    expect(diffs.every((d) => d.diff === null)).toBe(true);
    const snapshot = (await ctx.db.selectFrom('invoice').select('recipient').where('id', '=', inv.id).executeTakeFirstOrThrow()).recipient as { recipient: { lines: string[] } };
    expect(snapshot.recipient.lines.join(' ')).toContain('Zahler');

    // Restore of an older backup: the person is back, the erasure log replays.
    await ctx.db.updateTable('person').set({ last_name: 'Zahler', anonymised_at: null }).where('id', '=', m.personId).execute();
    await appendFile(join(config.filesDir, 'erasure-log.jsonl'), '{"o": "kaputt\n');
    const warnings: string[] = [];
    expect(await replayErasures(ctx.db, { warn: (w) => warnings.push(w) })).toBe(1);
    expect(warnings).toHaveLength(1);
    expect((await ctx.db.selectFrom('person').select('last_name').where('id', '=', m.personId).executeTakeFirstOrThrow()).last_name).toBe('Anonymisiert');
  });

  it('exports what is stored about a person and lists former members due for erasure', async () => {
    const m = await formerMember('Export');
    await admin.post(`/persons/${m.personId}/consents`, { purpose: 'photos', source: 'paper' });
    const res = await ctx.app.inject({ url: `/api/v1/persons/${m.personId}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const z = res.rawPayload;
    const nameLen = z.readUInt16LE(26);
    expect(z.subarray(30, 30 + nameLen).toString()).toBe('daten.json');
    const json = JSON.parse(inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + z.readUInt32LE(18))).toString());
    expect(json.Stammdaten[0].Nachname).toBe('Export');
    expect(json.Einwilligungen).toHaveLength(1);
    expect(json.Mitgliedschaften[0].Status).toBe('former');

    const review = (await admin.get('/privacy/review')).body;
    expect(review.items.map((i: { name: string }) => i.name)).toEqual(['Export, Paula']);
  });

  it('anonymises a donor whose donation is on a valid receipt, keeps the receipt, and lets only admins export', async () => {
    const accounts = (await admin.get('/ledger/accounts')).body as { id: string; number: string }[];
    const acc = (n: string) => accounts.find((a) => a.number === n)!.id;
    const d = await admin.post('/donations', { donor: { lastName: 'Spender', firstName: 'Sina', street: 'Weg 2', postalCode: '12345', city: 'Musterstadt' }, date: '2026-03-05', amountCents: 25000, moneyAccountId: acc('1100'), incomeAccountId: acc('4100'), note: 'per Brief zugesagt' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    await admin.put('/donations/settings', { kind: 'freistellung', office: 'Musterstadt', taxNumber: '12/345/67890', date: `${new Date().getFullYear() - 1}-05-01`, period: '2021–2023', purposes: 'des Sports (§ 52 Abs. 2 Satz 1 Nr. 21 AO)', signer: 'Erika Mustermann, Kassenwartin' });
    const receipt = await admin.post('/donation-receipts', { personId: d.body.personId, donationIds: [d.body.id] });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);

    // Only a club-wide admin gets the complete Art. 15 export.
    const tax = await userWithRole(ctx.app, cookie, 'Steuerberatung');
    expect((await ctx.app.inject({ url: `/api/v1/persons/${d.body.personId}/export`, headers: { cookie: tax } })).statusCode).toBe(403);

    const done = await admin.post(`/persons/${d.body.personId}/anonymise`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const row = await ctx.db.selectFrom('donation').select(['note', 'amount_cents']).where('id', '=', d.body.id).executeTakeFirstOrThrow();
    expect([row.note, Number(row.amount_cents)]).toEqual([null, 25000]);
    expect((await ctx.db.selectFrom('donation_receipt').select('status').where('id', '=', receipt.body.id).executeTakeFirstOrThrow()).status).toBe('issued');
    // The trigger still freezes everything else on a receipted donation.
    await expect(ctx.db.updateTable('donation').set({ amount_cents: 1 }).where('id', '=', d.body.id).execute()).rejects.toThrow(/receipt/);
  });

  it('keeps idempotency keys through an anonymisation, so a retry is not booked twice', async () => {
    const m = await formerMember('Retry');
    const key = 'retry-key-0001';
    const create = () => ctx.app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { cookie, 'idempotency-key': key }, payload: { memberId: m.id, lines: [{ text: 'Beitrag', unitCents: 6000 }] } });
    expect((await create()).statusCode).toBe(201);
    const count = async () => (await ctx.db.selectFrom('invoice').select('id').execute()).length;
    const before = await count();
    const other = await formerMember('Andere');
    expect((await admin.post(`/persons/${other.personId}/anonymise`, {})).status).toBe(200);
    const again = await create();
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().type).toMatch(/idempotency-already-done$/);
    expect(await count()).toBe(before);
  });
});
