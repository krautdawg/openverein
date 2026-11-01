import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { applyImport, planImport, readKiKlub } from '../src/server/profiles/importKiKlub.ts';
import { testDbUrl } from './global-setup.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Change public-profiles, slice 3: KI Klub profiles imported from a fixture with KI Klub's own tables. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-kiklub-import-'));
const ctx = await testApp();
afterAll(async () => {
  await sql.raw('drop schema if exists kiklub_fixture cascade').execute(ctx.db);
  await ctx.close();
});

let admin: ReturnType<typeof client>;
let org: string;
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 7)]);

beforeEach(async () => {
  await reset(ctx.db);
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
  org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
  // KI Klub's tables as in its shared/schema.ts (the columns the import reads).
  await sql.raw(`drop schema if exists kiklub_fixture cascade; create schema kiklub_fixture;
    create table kiklub_fixture.klub_mitglied (id uuid primary key, vorname text, nachname text, email text not null unique);
    create table kiklub_fixture.klub_profil (id uuid primary key, mitglied_id uuid not null references kiklub_fixture.klub_mitglied, anzeigename text, bio text, ort text, organisation text,
      linkedin_url text, foto bytea, foto_content_type text, profil_modus text not null default 'keiner', profi_freigabe boolean not null default false, profi_freigabe_am timestamptz,
      sichtbarkeit_kontakt text not null default 'vorstand');
    create table kiklub_fixture.klub_profil_link (id uuid primary key, profil_id uuid not null references kiklub_fixture.klub_profil, label text not null, url text not null, sortierung int not null default 0);`).execute(ctx.db);
  const m = async (id: string, email: string) => sql`insert into kiklub_fixture.klub_mitglied values (${id}::uuid, 'X', 'Y', ${email})`.execute(ctx.db);
  await m('00000000-0000-4000-8000-000000000001', 'ada@example.org');
  await m('00000000-0000-4000-8000-000000000002', 'niemand@example.org');
  await m('00000000-0000-4000-8000-000000000003', 'Bo@Example.org');
  await m('00000000-0000-4000-8000-000000000004', 'doppelt@example.org');
  await sql`insert into kiklub_fixture.klub_profil (id, mitglied_id, anzeigename, bio, ort, organisation, linkedin_url, foto, foto_content_type, profil_modus, profi_freigabe, profi_freigabe_am, sichtbarkeit_kontakt) values
    ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Ada L.', 'Baut Agenten.', 'Werder', 'Lovelace GmbH', 'https://linkedin.com/in/ada', ${WEBP}, 'image/webp', 'profi', true, '2026-09-01T10:00:00Z', 'oeffentlich'),
    ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Nie Mand', null, null, null, null, null, null, 'enthusiast', true, now(), 'vorstand'),
    ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', 'Bo', 'Noch nicht öffentlich.', null, null, null, ${Buffer.from('kein bild')}, 'image/png', 'keiner', false, null, 'mitglieder'),
    ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', 'Doppelt', null, null, null, null, null, null, 'enthusiast', false, null, 'vorstand')`.execute(ctx.db);
  await sql`insert into kiklub_fixture.klub_profil_link values
    ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Blog', 'https://ada.example/blog', 2),
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Website', 'https://ada.example', 1),
    ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Kaputt', 'javascript:alert(1)', 3)`.execute(ctx.db);
  // OpenVerein members: Ada (with an older profile), Bo, and two memberships under one address.
  for (const [first, email] of [['Ada', 'ada@example.org'], ['Bo', 'bo@example.org'], ['Dora', 'doppelt@example.org'], ['Doro', 'doppelt@example.org']] as const) {
    await admin.post('/members', { firstName: first, lastName: 'Klub', email, joinDate: '2024-01-01' });
  }
  const ada = await ctx.db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select('member.id').where('person.email', '=', 'ada@example.org').executeTakeFirstOrThrow();
  await ctx.db.insertInto('member_profile').values({ organization_id: org, member_id: ada.id, bio: 'Alt.' }).execute();
});

describe('KI Klub profile import', () => {
  it('plans first and writes nothing; then imports with types, links, approval, visibility and photo', async () => {
    const source = await readKiKlub(testDbUrl, 'kiklub_fixture');
    expect(source).toHaveLength(4);
    const plan = await planImport(ctx.db, org, source);
    expect(plan.map((r) => [r.email, r.action, r.reason ?? null])).toEqual([
      ['ada@example.org', 'update', null],
      ['niemand@example.org', 'skip', 'Kein Mitglied mit dieser E-Mail-Adresse'],
      ['bo@example.org', 'create', null],
      ['doppelt@example.org', 'skip', 'Mehrere Mitgliedschaften mit dieser E-Mail-Adresse'],
    ]);
    expect(plan[0]!.notes).toEqual(['1 Link(s) ohne gültige http(s)-Adresse ausgelassen']);
    expect(plan[2]!.notes).toEqual(['Foto ist kein JPG, PNG oder WebP: ausgelassen']);
    // The dry run left everything as it was.
    expect((await ctx.db.selectFrom('member_profile').select('bio').execute()).map((r) => r.bio)).toEqual(['Alt.']);
    expect((await ctx.db.selectFrom('organization').select('profile_types').executeTakeFirstOrThrow()).profile_types).toEqual([]);

    const { withoutConsent } = await applyImport(ctx.db, org, source);
    expect(withoutConsent).toBe(1);
    expect((await ctx.db.selectFrom('organization').select('profile_types').executeTakeFirstOrThrow()).profile_types).toEqual([{ key: 'enthusiast', label: 'KI-Enthusiast' }, { key: 'profi', label: 'KI-Profi' }]);
    const feed = (await ctx.app.inject({ url: '/api/v1/public/profiles' })).json().profiles;
    expect(feed).toEqual([{
      id: expect.any(String), type: 'profi', typeLabel: 'KI-Profi', name: 'Ada L.', bio: 'Baut Agenten.', place: 'Werder', organisation: 'Lovelace GmbH',
      links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/ada' }, { label: 'Website', url: 'https://ada.example' }, { label: 'Blog', url: 'https://ada.example/blog' }],
      // The photo is stored, but public only once Ada gives the photos consent in OpenVerein.
      photoUrl: null, email: 'ada@example.org',
    }]);
    const photo = await ctx.db.selectFrom('file').select(['mime_type', 'purpose']).where('purpose', '=', 'photo').execute();
    expect(photo).toEqual([{ mime_type: 'image/webp', purpose: 'photo' }]);
    const bo = await ctx.db.selectFrom('member_profile').innerJoin('member', 'member.id', 'member_profile.member_id').innerJoin('person', 'person.id', 'member.person_id').select(['member_profile.type_key', 'member_profile.contact_visibility', 'member_profile.approved_at']).where('person.email', '=', 'bo@example.org').executeTakeFirstOrThrow();
    expect(bo).toEqual({ type_key: 'none', contact_visibility: 'members', approved_at: null });
    expect(await ctx.db.selectFrom('audit_event').select('id').where('action', '=', 'profile.imported').execute()).toHaveLength(2);
  });
});
