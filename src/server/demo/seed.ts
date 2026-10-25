import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { buildApp } from '../app.ts';
import type { Db } from '../db.ts';
import { MIGRATIONS_TABLE } from '../migrate.ts';
import { DEMO_LOGIN, DEMO_SEED_KEY } from './login.ts';

export { DEMO_LOGIN };

const CLUB = 'SV Lindenhof 1921 e.V.';

/** Deterministic pseudo-random numbers, so every reset produces the same club. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A valid German test IBAN for an account at the given Bankleitzahl (mod-97 check digits). */
export function testIban(blz: string, account: number) {
  const bban = blz + String(account).padStart(10, '0');
  const rearranged = `${bban}131400`; // D=13, E=14, check digits 00
  let rem = 0;
  for (const ch of rearranged) rem = (rem * 10 + Number(ch)) % 97;
  return `DE${String(98 - rem).padStart(2, '0')}${bban}`;
}

// Demo genders follow the first name (a few without entry); not drawn from the random stream, so the rest stays the same.
const FEMALE = new Set(['Anna', 'Clara', 'Emma', 'Greta', 'Ida', 'Karla', 'Mia', 'Olivia', 'Rosa', 'Tilda', 'Vera', 'Yasmin', 'Zoe', 'Ayşe', 'Nele', 'Pia', 'Lotta', 'Frieda', 'Lina', 'Sophie', 'Elif']);
const FIRST = ['Anna', 'Ben', 'Clara', 'David', 'Emma', 'Felix', 'Greta', 'Hannes', 'Ida', 'Jonas', 'Karla', 'Leon', 'Mia', 'Noah', 'Olivia', 'Paul', 'Rosa', 'Samuel', 'Tilda', 'Ugur', 'Vera', 'Wim', 'Yasmin', 'Zoe', 'Ayşe', 'Jörg', 'Malte', 'Nele', 'Ole', 'Pia', 'Quentin', 'Lotta', 'Emil', 'Frieda', 'Henri', 'Lina', 'Mats', 'Sophie', 'Theo', 'Elif'];
const LAST = ['Becker', 'Braun', 'Demir', 'Fischer', 'Hartmann', 'Hoffmann', 'Jung', 'Kaiser', 'Keller', 'Koch', 'Kowalski', 'Krause', 'Lange', 'Lehmann', 'Meyer', 'Neumann', 'Nowak', 'Otto', 'Peters', 'Richter', 'Schäfer', 'Schmidt', 'Schneider', 'Schulz', 'Vogel', 'Wagner', 'Weber', 'Wolf', 'Yılmaz', 'Zimmermann'];
const STREETS = ['Lindenallee', 'Am Sportplatz', 'Ringstraße', 'Gartenweg', 'Hauptstraße', 'Schulstraße', 'Mühlenweg', 'Birkenhof'];

/** Empties every table (demo instances only). Audit rows are append-only, so triggers are bypassed for this one statement. */
export async function wipe(db: Db) {
  const tables = await sql<{ t: string }>`select tablename as t from pg_tables where schemaname = 'public' and tablename <> ${MIGRATIONS_TABLE}`.execute(db);
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql.raw(`truncate ${tables.rows.map((r) => `"${r.t}"`).join(', ')} cascade`).execute(tx);
  });
}

/**
 * Seeds the demo club through the public API, so every record passes the same rules as manual entry.
 * Refuses when the instance holds a real club.
 */
export async function seedDemo(db: Db, opts: { reset?: boolean; members?: number } = {}) {
  const org = await db.selectFrom('organization').select(['id', 'is_demo']).executeTakeFirst();
  if (org && !org.is_demo) throw new Error('Diese Instanz enthält einen echten Verein. Die Demo wird hier nicht geladen.');
  if (org && !opts.reset) throw new Error('Die Demo ist schon geladen. Zum Zurücksetzen: --reset');
  if (org) await wipe(db);

  const app = await buildApp(db, { serveWeb: false, authRateLimit: 1_000_000, demoSeed: true });
  await app.ready();
  try {
    // The key marks the club as demo inside the setup transaction; in demo mode nobody else may run setup.
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-demo-seed': DEMO_SEED_KEY }, payload: { clubName: CLUB, name: 'Erika Mustermann', ...DEMO_LOGIN } });
    if (setup.statusCode !== 201 && setup.statusCode !== 200) throw new Error(`Setup fehlgeschlagen: ${setup.body}`);
    const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
    const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => {
      const r = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
      if (r.statusCode >= 400) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`);
      return r.body ? r.json() : null;
    };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
    const year = today.slice(0, 4);
    await call('PATCH', '/organization', { street: 'Am Sportplatz 1', postalCode: '12345', city: 'Lindenhof', email: 'vorstand@sv-lindenhof.example', iban: testIban('37040044', 532013000), bic: 'COBADEFFXXX', bankName: 'Testbank', creditorId: 'DE98ZZZ09999999999', mailFromName: CLUB });

    const group = async (name: string, shortCode: string, kind: string, color: string) => (await call('POST', '/groups', { name, shortCode, kind, color })).id as string;
    const fussball = await group('Fußball', 'FB', 'division', 'gruen');
    const turnen = await group('Turnen', 'TU', 'division', 'blau');
    const tennis = await group('Tennis', 'TE', 'division', 'orange');
    const jugend = await group('Jugend', 'JU', 'team', 'gelb');
    const vorstand = await group('Vorstand', 'VS', 'board', 'schwarz');

    const plan = async (name: string, amountCents: number) => (await call('POST', '/fee-plans', { name, version: { validFrom: '2015-01-01', amountCents, intervalMonths: 12, anchor: 'calendar', proration: 'month' } })).id as string;
    const adults = await plan('Erwachsene', 12000);
    const youth = await plan('Kinder und Jugendliche', 6000);
    const reduced = await plan('Ermäßigt', 8000);

    const r = rng(1921);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const date = (from: number, to: number) => {
      const end = Math.min(Date.UTC(to, 11, 31), Date.parse(`${today}T00:00:00Z`));
      const d = new Date(Date.UTC(from, 0, 1) + r() * (end - Date.UTC(from, 0, 1)));
      return d.toISOString().slice(0, 10);
    };
    const members: { id: string; age: number; debit: boolean }[] = [];
    for (let i = 0; i < (opts.members ?? 150); i++) {
      const firstName = pick(FIRST);
      const lastName = pick(LAST);
      const birthDate = date(1945, 2019);
      const age = Number(year) - Number(birthDate.slice(0, 4));
      const joinDate = date(Math.max(Number(birthDate.slice(0, 4)) + 4, 2005), Number(year));
      const divisions = [age < 18 ? jugend : null, pick([fussball, turnen, tennis, fussball, turnen])].filter((x): x is string => !!x);
      if (i < 5) divisions.push(vorstand);
      const m = await call('POST', '/members', {
        firstName, lastName, birthDate, gender: i % 37 === 0 ? null : FEMALE.has(firstName) ? 'female' : 'male',
        email: r() < 0.85 ? `${firstName}.${lastName}.${i}@example.org`.toLowerCase().normalize('NFD').replace(/[^a-z0-9.@-]/g, '') : null,
        phone: r() < 0.5 ? `0171 ${String(1000000 + Math.floor(r() * 8999999))}` : null,
        street: `${pick(STREETS)} ${1 + Math.floor(r() * 80)}`, postalCode: '12345', city: 'Lindenhof',
        joinDate, groupIds: divisions,
      });
      const debit = r() < 0.7;
      if (debit) {
        await call('POST', `/members/${m.id}/mandates`, { signedOn: joinDate, accountHolder: age < 18 ? `${pick(FIRST)} ${lastName}` : `${firstName} ${lastName}`, iban: testIban('37040044', 1000000 + i) });
        await call('PATCH', `/members/${m.id}/payment-method`, { paymentMethod: 'direct_debit' });
      }
      await call('POST', `/members/${m.id}/fee-assignments`, { feePlanId: age < 18 ? youth : age > 70 ? reduced : adults, validFrom: joinDate });
      // About one in ten has already left or is leaving.
      if (r() < 0.1) {
        const noticeDate = date(Math.max(Number(joinDate.slice(0, 4)), Number(year) - 2), Number(year));
        const exitDate = `${Number(noticeDate.slice(0, 4))}-12-31`;
        if (noticeDate > joinDate) await call('POST', `/members/${m.id}/resign`, { noticeDate, exitDate, exitReason: pick(['Umzug', 'keine Zeit mehr', 'Studium']) });
      }
      members.push({ id: m.id, age, debit });
    }

    // This year's fees: one posted run, and about half of the transfers already paid.
    // Issued on 1 February, or today early in the year; payments never lie in the future.
    const issueDate = `${year}-02-01` < today ? `${year}-02-01` : today;
    const run = await call('POST', '/fee-runs', { until: `${year}-12-31`, issueDate, dueDate: `${year}-03-01` > issueDate ? `${year}-03-01` : today });
    await call('POST', `/fee-runs/${run.id}/post`, {});
    const invoices = (await call('GET', '/invoices?status=open&limit=200')).items as { id: string; openCents: number; memberId: string }[];
    for (const inv of invoices) {
      const m = members.find((x) => x.id === inv.memberId);
      const bookedOn = `${year}-02-${String(10 + Math.floor(r() * 18)).padStart(2, '0')}`;
      if (m && !m.debit && r() < 0.55) await call('POST', `/invoices/${inv.id}/payments`, { amountCents: inv.openCents, bookedOn: bookedOn < today ? bookedOn : today, method: 'transfer' });
    }

    // Calendar: trainings, matches, board meetings.
    const cal = async (name: string, color: string, groupIds?: string[]) => (await call('POST', '/calendars', { name, color, groupIds })).id as string;
    const training = await cal('Training', 'gruen');
    const spiele = await cal('Spiele', 'orange');
    const board = await cal('Vorstand', 'schwarz', [vorstand]);
    const month = today.slice(0, 7);
    await call('POST', '/events', { calendarId: training, title: 'Fußball Jugend', location: 'Sportplatz', startsAt: `${month}-01T17:00`, endsAt: `${month}-01T18:30`, recurrence: { freq: 'WEEKLY', byDay: ['MO', 'WE'] }, maxParticipants: 22 });
    await call('POST', '/events', { calendarId: training, title: 'Turnen Erwachsene', location: 'Halle 2', startsAt: `${month}-01T19:00`, endsAt: `${month}-01T20:30`, recurrence: { freq: 'WEEKLY', byDay: ['TH'] } });
    await call('POST', '/events', { calendarId: training, title: 'Tennis Mixed', location: 'Platz 1 und 2', startsAt: `${month}-01T18:00`, endsAt: `${month}-01T20:00`, recurrence: { freq: 'WEEKLY', byDay: ['TU'] } });
    await call('POST', '/events', { calendarId: spiele, title: 'Heimspiel gegen TSV Musterstadt', location: 'Sportplatz', startsAt: `${month}-20T15:00`, endsAt: `${month}-20T17:00` });
    await call('POST', '/events', { calendarId: board, title: 'Vorstandssitzung', location: 'Vereinsheim', startsAt: `${month}-10T19:30`, endsAt: `${month}-10T21:30`, recurrence: { freq: 'MONTHLY' } });
    await call('POST', '/events', { calendarId: training, title: 'Erste-Hilfe-Kurs', location: 'Vereinsheim', startsAt: `${month}-27T10:00`, endsAt: `${month}-27T16:00`, maxParticipants: 12, priceCents: 1500 });

    await call('POST', '/folders', { name: 'Satzung und Ordnungen', shareWithMembers: true });
    await call('POST', '/folders', { name: 'Protokolle', groupIds: [vorstand] });
    await call('POST', '/application-forms', { slug: 'mitglied-werden', title: 'Mitglied werden', intro: 'Schön, dass Du zum SV Lindenhof möchtest. Dies ist eine Demo: Anträge landen im Posteingang der Demo und werden beim Zurücksetzen gelöscht.', groupIds: [fussball, turnen, tennis], feePlanIds: [adults, youth], consentText: 'Ich erkenne die Satzung an und willige in die Verarbeitung meiner Daten zur Mitgliederverwaltung ein.' });
    return { members: members.length };
  } finally {
    await app.close();
  }
}
