import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { applyImport, planDigest, planImport, readKiKlub } from '../src/server/profiles/importKiKlub.ts';
import { testDbUrl } from './global-setup.ts';
import { HOME, WEBP_GPS as WEBP } from './photos.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Change public-profiles, slice 3: KI Klub profiles imported once, from a fixture with KI Klub's own tables. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-kiklub-import-'));
const ctx = await testApp();
afterAll(async () => {
  await sql.raw('drop schema if exists kiklub_fixture cascade').execute(ctx.db);
  await ctx.close();
});

let admin: ReturnType<typeof client>;
let org: string;
const id = (n: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(async () => {
  await reset(ctx.db);
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
  // KI Klub's tables as in its shared/schema.ts (the columns the import reads).
  await sql.raw(`drop schema if exists kiklub_fixture cascade; create schema kiklub_fixture;
    create table kiklub_fixture.klub_mitglied (id uuid primary key, vorname text, nachname text, email text not null unique, status text not null default 'aktiv');
    create table kiklub_fixture.klub_profil (id uuid primary key, mitglied_id uuid not null references kiklub_fixture.klub_mitglied, anzeigename text, bio text, ort text, organisation text,
      linkedin_url text, foto bytea, foto_content_type text, profil_modus text not null default 'keiner', profi_freigabe boolean not null default false, profi_freigabe_am timestamptz,
      sichtbarkeit_kontakt text not null default 'vorstand');
    create table kiklub_fixture.klub_profil_link (id uuid primary key, profil_id uuid not null references kiklub_fixture.klub_profil, label text not null, url text not null, sortierung int not null default 0);`).execute(ctx.db);
  const people: [number, string, string, string, string, boolean, string, Buffer | null][] = [
    // n, email, status, mode, visibility, approved, name, photo
    [1, 'ada@example.org', 'aktiv', 'profi', 'oeffentlich', true, 'Ada L.', WEBP],
    [2, 'niemand@example.org', 'aktiv', 'enthusiast', 'vorstand', true, 'Nie Mand', null],
    [3, ' Bo@Example.org ', 'aktiv', 'keiner', 'mitglieder', false, 'Bo', Buffer.from('kein bild')],
    [4, 'doppelt@example.org', 'aktiv', 'enthusiast', 'vorstand', true, 'Doppelt', null],
    [5, 'ruhend@example.org', 'ruhend', 'profi', 'vorstand', true, 'Ruth', null],
    [6, 'weg@example.org', 'ausgetreten', 'profi', 'vorstand', true, 'Weg', null],
    [7, 'eve@example.org', 'aktiv', 'profi', 'vorstand', true, 'Eve', null],
    [8, 'neu@example.org', 'aktiv', 'profi', 'vorstand', true, 'Neu', null],
  ];
  for (const [n, email, status, mode, vis, approved, name, photo] of people) {
    await sql`insert into kiklub_fixture.klub_mitglied values (${id(n)}::uuid, 'X', 'Y', ${email}, ${status})`.execute(ctx.db);
    await sql`insert into kiklub_fixture.klub_profil (id, mitglied_id, anzeigename, bio, ort, organisation, linkedin_url, foto, profil_modus, profi_freigabe, profi_freigabe_am, sichtbarkeit_kontakt)
      values (${id(n, '1')}::uuid, ${id(n)}::uuid, ${name}, ${`Text von ${name}.`}, 'Werder', null, ${n === 1 ? 'https://linkedin.com/in/ada' : null}, ${photo}, ${mode}, ${approved}, ${approved ? '2026-09-01T10:00:00Z' : null}, ${vis})`.execute(ctx.db);
  }
  await sql`insert into kiklub_fixture.klub_profil_link values
    (${id(2, '2')}::uuid, ${id(1, '1')}::uuid, 'Blog', 'https://ada.example/blog', 2),
    (${id(1, '2')}::uuid, ${id(1, '1')}::uuid, 'Website', 'https://ada.example', 1),
    (${id(3, '2')}::uuid, ${id(1, '1')}::uuid, 'Kaputt', 'javascript:alert(1)', 3)`.execute(ctx.db);
  // OpenVerein: Ada, Bo, Ruth, Eve (already with a profile), two people under one address, and a former member
  // whose address a new member reuses.
  for (const [first, email] of [['Ada', 'ada@example.org'], ['Bo', 'bo@example.org'], ['Ruth', 'ruhend@example.org'], ['Eve', 'eve@example.org'], ['Dora', 'doppelt@example.org'], ['Doro', 'doppelt@example.org'], ['Alt', 'neu@example.org'], ['Neu', 'neu@example.org']] as const) {
    await admin.post('/members', { firstName: first, lastName: 'Klub', email, joinDate: '2015-01-01' });
  }
  const alt = await ctx.db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select('member.id').where('person.first_name', '=', 'Alt').executeTakeFirstOrThrow();
  await ctx.db.updateTable('member').set({ status: 'former' }).where('id', '=', alt.id).execute();
  const eve = await ctx.db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select('member.id').where('person.email', '=', 'eve@example.org').executeTakeFirstOrThrow();
  await ctx.db.insertInto('member_profile').values({ organization_id: org, member_id: eve.id, bio: 'Eigene Fassung.', hidden: true }).execute();
});

describe('KI Klub profile import', () => {
  it('plans first, writes only the confirmed plan, publishes no more than KI Klub did, and never overwrites', async () => {
    const source = await readKiKlub(testDbUrl, 'kiklub_fixture');
    const plan = await planImport(ctx.db, org, source);
    expect(plan.map((r) => [r.email, r.action, r.reason ?? null])).toEqual([
      ['ada@example.org', 'create', null],
      ['niemand@example.org', 'skip', 'Kein Mitglied mit dieser E-Mail-Adresse'],
      ['bo@example.org', 'create', null],
      ['doppelt@example.org', 'skip', 'Mehrere Mitgliedschaften mit dieser E-Mail-Adresse'],
      ['ruhend@example.org', 'create', null],
      ['weg@example.org', 'skip', 'Im KI Klub ausgetreten'],
      ['eve@example.org', 'skip', 'Hat in OpenVerein schon ein Profil (wird nicht überschrieben)'],
      // A former member's address reused by a new member: not unambiguous, so skipped.
      ['neu@example.org', 'skip', 'Mehrere Mitgliedschaften mit dieser E-Mail-Adresse'],
    ]);
    expect(plan[0]).toMatchObject({ typeKey: 'profi', approved: true, visibility: 'members', photo: true });
    expect(plan[0]!.notes).toEqual(['Kontakt „öffentlich“ wird zu „Mitglieder“ (der KI Klub zeigte die Adresse nie öffentlich)', '1 Link(s) ohne gültige http(s)-Adresse ausgelassen']);
    expect(plan[4]).toMatchObject({ typeKey: 'profi', approved: false });
    // Nothing written by the plan.
    expect(await ctx.db.selectFrom('member_profile').select('id').execute()).toHaveLength(1);

    // Only the reviewed plan is written: a wrong code changes nothing.
    await expect(applyImport(ctx.db, org, source, 'falsch')).rejects.toThrow(/geändert/);
    expect(await ctx.db.selectFrom('member_profile').select('id').execute()).toHaveLength(1);
    const { withoutConsent } = await applyImport(ctx.db, org, source, planDigest(plan, source));
    expect(withoutConsent).toBe(1);
    expect((await ctx.db.selectFrom('organization').select('profile_types').executeTakeFirstOrThrow()).profile_types).toEqual([{ key: 'enthusiast', label: 'KI-Enthusiast' }, { key: 'profi', label: 'KI-Profi' }]);
    const feed = (await ctx.app.inject({ url: '/api/v1/public/profiles' })).json().profiles;
    expect(feed).toEqual([{
      id: expect.any(String), type: 'profi', typeLabel: 'KI-Profi', name: 'Ada L.', bio: 'Text von Ada L..', place: 'Werder', organisation: null,
      links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/ada' }, { label: 'Website', url: 'https://ada.example' }, { label: 'Blog', url: 'https://ada.example/blog' }],
      // The photo is stored but public only with the photos consent; KI Klub never showed the address publicly.
      photoUrl: null, email: null,
    }]);
    // The imported photo is stored without its camera metadata.
    const { getBlob } = await import('../src/server/files/store.ts');
    const f = await ctx.db.selectFrom('file').select('sha256').where('purpose', '=', 'photo').executeTakeFirstOrThrow();
    expect((await getBlob(f.sha256)).includes(HOME)).toBe(false);
    // Eve's own (hidden) profile is untouched.
    expect((await ctx.db.selectFrom('member_profile').select(['bio', 'hidden']).where('bio', '=', 'Eigene Fassung.').executeTakeFirstOrThrow()).hidden).toBe(true);
    expect(await ctx.db.selectFrom('audit_event').select('id').where('action', 'in', ['profile.imported', 'profile_types.updated']).execute()).toHaveLength(4);

    // A second run imports nothing: everyone now has a profile.
    const again = await planImport(ctx.db, org, source);
    expect(again.filter((r) => r.action === 'create')).toEqual([]);
  });
});
