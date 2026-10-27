import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { encrypt } from '../src/server/crypto.ts';
import { demoResetting } from '../src/server/demo/reset.ts';
import { parseIcs } from '../src/server/events/icsImport.ts';
import { sweepFiles } from '../src/server/files/store.ts';
import { issueLoginCode } from '../src/server/routes/portal.ts';
import { addBusinessDays } from '../src/server/sepa/pain.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Findings of the second (Codex) review of group G15 (#77-#84). Each test failed on the code before the fix. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-g15b-'));
const ctx = await testApp();
afterAll(() => {
  config.multiTenant = false;
  config.operatorToken = '';
  return ctx.close();
});

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
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

describe('G15 second review', () => {
  it('does not expire a temporary file that was kept while the sweep waited', async () => {
    const up = await ctx.app.inject({ method: 'POST', url: '/api/v1/files?name=Liste.csv&retentionClass=temporary', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/csv' }, payload: 'a;b' });
    expect(up.statusCode, up.body).toBe(201);
    await ctx.db.updateTable('file').set({ temporary_since: new Date(Date.now() - 8 * 86_400_000) }).execute();
    const keep = ctx.db.transaction().execute(async (tx) => {
      await tx.selectFrom('file').select('id').forUpdate().execute();
      await tx.updateTable('file').set({ retention_class: 'document', temporary_since: null }).execute();
      await sleep(300);
    });
    await sleep(50);
    await sweepFiles(ctx.db);
    await keep;
    expect(await ctx.db.selectFrom('file').select('id').execute()).toHaveLength(1);
  });

  it('charges the price the event has when the place is taken', async () => {
    const calendarId = (await admin.post('/calendars', { name: 'Kurse', color: 'gruen' })).body.id;
    const d = future(10);
    const ev = (await admin.post('/events', { calendarId, title: 'Kletterkurs', startsAt: `${d}T10:00`, endsAt: `${d}T12:00`, priceCents: 4500 })).body;
    const m = (await admin.post('/members', { lastName: 'Kletter', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body.id;
    const cheaper = ctx.db.transaction().execute(async (tx) => {
      await tx.selectFrom('event').select('id').where('id', '=', ev.eventId).forUpdate().execute();
      await tx.updateTable('event').set({ price_cents: 3000 }).where('id', '=', ev.eventId).execute();
      await sleep(300);
    });
    await sleep(50);
    const rsvp = admin.put(`/events/${ev.eventId}/occurrences/${d}/participants/${m}`, { status: 'yes' });
    await cheaper;
    expect((await rsvp).status).toBe(200);
    const inv = await ctx.db.selectFrom('invoice').select('total_cents').executeTakeFirstOrThrow();
    expect(Number(inv.total_cents)).toBe(3000);
  });

  it('refuses a child price without a regular price or above it', async () => {
    const calendarId = (await admin.post('/calendars', { name: 'Kurse', color: 'gruen' })).body.id;
    const d = future(10);
    const base = { calendarId, title: 'Ferienkurs', startsAt: `${d}T10:00`, endsAt: `${d}T12:00`, childUpToAge: 12 };
    expect((await admin.post('/events', { ...base, childPriceCents: 1000 })).status).toBe(409);
    expect((await admin.post('/events', { ...base, priceCents: 1000, childPriceCents: 2000 })).status).toBe(409);
    expect((await admin.post('/events', { ...base, priceCents: 2000, childPriceCents: 1000 })).status).toBe(201);
  });

  it('does not re-arm an amendment that another submitted run already carried', async () => {
    await admin.patch('/organization', { creditorId: 'DE98ZZZ09999999999', prenotificationDays: 1 });
    const accountId = (await admin.post('/bank-accounts', { name: 'Vereinskonto', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', openingDate: '2026-01-01', openingBalanceCents: 0 })).body.id;
    const m = (await admin.post('/members', { lastName: 'Lastschrift', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2020-01-01' })).body.id;
    await admin.patch(`/members/${m}/payment-method`, { paymentMethod: 'direct_debit' });
    await admin.post(`/members/${m}/mandates`, { signedOn: '2024-01-15', accountHolder: 'Lea Lastschrift', iban: 'DE89370400440532013000' });
    await ctx.db.updateTable('sepa_mandate').set({ first_collected: true, amendment_pending: true, amended_from_iban_encrypted: encrypt('DE02120300000000202051') }).execute();
    const run = async () => {
      const inv = (await admin.post('/invoices', { memberId: m, dueDate: today(), lines: [{ text: 'Beitrag', unitCents: 5000 }] })).body;
      await admin.post(`/invoices/${inv.id}/issue`, {});
      const r = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: addBusinessDays(today(), 5), invoiceIds: [inv.id] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const a = await run();
    const b = await run();
    const sub = await admin.post(`/collection-runs/${b}/submitted`, {});
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect((await admin.post(`/collection-runs/${a}/release`, { reason: 'Doppelt erzeugt', confirmNotSubmitted: true })).status).toBe(200);
    expect((await ctx.db.selectFrom('sepa_mandate').select('amendment_pending').executeTakeFirstOrThrow()).amendment_pending).toBe(false);
  });

  it('does not overwrite a member edit made while the import was being confirmed', async () => {
    const m = (await admin.post('/members', { firstName: 'Ida', lastName: 'Import', city: 'Altstadt', joinDate: '2024-01-01', membershipNumber: 'I-1' })).body;
    const content = 'Nachname;Vorname;Eintritt;Mitgliedsnummer;Ort\nImport;Ida;01.01.2024;I-1;Neustadt';
    const p = await admin.post('/imports/members/preview', { content, matchKey: 'number' });
    const edit = ctx.db.transaction().execute(async (tx) => {
      await tx.updateTable('person').set({ city: 'Handstadt' }).where('id', '=', m.personId).execute();
      await sleep(300);
    });
    await sleep(50);
    const run = admin.post('/imports/members', { content, matchKey: 'number', planHash: p.body.planHash });
    await edit;
    expect((await run).status).toBe(409);
    expect((await ctx.db.selectFrom('person').select('city').where('id', '=', m.personId).executeTakeFirstOrThrow()).city).toBe('Handstadt');
  });

  it('accepts a portal code only at the club that issued it', async () => {
    await reset(ctx.db);
    config.multiTenant = true;
    config.operatorToken = 'o'.repeat(40);
    try {
      const tenant = async (clubName: string, hostname: string) => {
        const t = await ctx.app.inject({ method: 'POST', url: '/api/v1/operator/tenants', headers: { 'x-operator-token': config.operatorToken }, payload: { clubName, hostname, adminName: 'Ada Admin', adminEmail: `admin@${hostname}` } });
        expect(t.statusCode, t.body).toBe(201);
        return t.json().id as string;
      };
      const a = await tenant('TSV A', 'verein-a.example.org');
      await tenant('SV B', 'verein-b.example.org');
      const code = await issueLoginCode(ctx.db, a, 'paula@example.org', null);
      const atB = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', headers: { host: 'verein-b.example.org' }, payload: { email: 'paula@example.org', code } });
      expect(atB.statusCode).toBe(400);
      const atA = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/auth/verify', headers: { host: 'verein-a.example.org' }, payload: { email: 'paula@example.org', code } });
      expect(atA.statusCode, atA.body).toBe(200);
    } finally {
      config.multiTenant = false;
      config.operatorToken = '';
    }
  });

  it('skips a calendar entry whose given end cannot be read', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x1', 'SUMMARY:Training', 'DTSTART:20261201T100000Z', 'DTEND:20261345T110000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const r = parseIcs(ics, 'Europe/Berlin');
    expect(r.events).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });

  it('tells every instance that the demo is being reset', async () => {
    void org;
    await ctx.db.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(hashtext('openverein:demo-reset'))`.execute(conn);
      try {
        expect(await demoResetting(ctx.db)).toBe(true);
      } finally {
        await sql`select pg_advisory_unlock(hashtext('openverein:demo-reset'))`.execute(conn);
      }
    });
  });
});
