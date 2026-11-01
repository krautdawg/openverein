import pg from 'pg';
import type { Db } from '../db.ts';
import { audit } from '../audit.ts';
import { putBlob } from '../files/store.ts';
import { imageTypeOf } from './service.ts';

/**
 * Import of KI Klub Werder profiles (change public-profiles, slice 3): klub_profil with its links and photo
 * (bytea), matched to members of an OpenVerein club by e-mail. Dry run first: `plan` reports, `apply` writes.
 * Never run against KI Klub production from here; Tim migrates after his own test.
 */
export interface SourceProfile {
  email: string;
  displayName: string | null;
  bio: string | null;
  place: string | null;
  organisation: string | null;
  linkedinUrl: string | null;
  mode: string;
  approved: boolean;
  approvedAt: Date | null;
  visibility: string;
  photo: Buffer | null;
  links: { label: string; url: string }[];
}

export const KI_KLUB_TYPES = [
  { key: 'enthusiast', label: 'KI-Enthusiast' },
  { key: 'profi', label: 'KI-Profi' },
];
const MODE: Record<string, string> = { keiner: 'none', enthusiast: 'enthusiast', profi: 'profi' };
const VISIBILITY: Record<string, 'board' | 'members' | 'public'> = { vorstand: 'board', mitglieder: 'members', oeffentlich: 'public' };
const CURRENT = ['applicant', 'future', 'active', 'resigned'];

/** Reads the KI Klub tables (klub_mitglied, klub_profil, klub_profil_link) from a database, optionally a schema. */
export async function readKiKlub(connectionString: string, schema = 'public'): Promise<SourceProfile[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const s = client.escapeIdentifier(schema);
    const profiles = await client.query(`
      select p.id, lower(trim(m.email)) as email, p.anzeigename, p.bio, p.ort, p.organisation, p.linkedin_url, p.profil_modus,
             p.profi_freigabe, p.profi_freigabe_am, p.sichtbarkeit_kontakt, p.foto
      from ${s}.klub_profil p join ${s}.klub_mitglied m on m.id = p.mitglied_id`);
    const links = await client.query(`select profil_id, label, url from ${s}.klub_profil_link order by profil_id, sortierung`);
    return profiles.rows.map((r) => ({
      email: r.email,
      displayName: r.anzeigename,
      bio: r.bio,
      place: r.ort,
      organisation: r.organisation,
      linkedinUrl: r.linkedin_url,
      mode: r.profil_modus,
      approved: r.profi_freigabe,
      approvedAt: r.profi_freigabe_am,
      visibility: r.sichtbarkeit_kontakt,
      photo: r.foto,
      links: links.rows.filter((l) => l.profil_id === r.id).map((l) => ({ label: l.label, url: l.url })),
    }));
  } finally {
    await client.end();
  }
}

export interface PlannedRow { email: string; action: 'create' | 'update' | 'skip'; reason?: string; memberId?: string; notes: string[] }

const clip = (v: string | null, n: number) => (v && v.trim() ? v.trim().slice(0, n) : null);

/** The links as OpenVerein keeps them: the LinkedIn field first (unless already a link), at most 10, http(s) only. */
function linksOf(p: SourceProfile, notes: string[]) {
  const all = [...(p.linkedinUrl && !p.links.some((l) => l.url === p.linkedinUrl) ? [{ label: 'LinkedIn', url: p.linkedinUrl }] : []), ...p.links];
  const ok = all.filter((l) => /^https?:\/\/\S+$/i.test(l.url.trim()) && l.label.trim()).map((l) => ({ label: l.label.trim().slice(0, 60), url: l.url.trim().slice(0, 500) }));
  if (ok.length < all.length) notes.push(`${all.length - ok.length} Link(s) ohne gültige http(s)-Adresse ausgelassen`);
  if (ok.length > 10) notes.push(`${ok.length - 10} Link(s) über der Grenze von 10 ausgelassen`);
  return ok.slice(0, 10);
}

/** What the import would do, per KI Klub profile; writes nothing. */
export async function planImport(db: Db, organizationId: string, source: SourceProfile[]): Promise<PlannedRow[]> {
  const rows: PlannedRow[] = [];
  for (const p of source) {
    const notes: string[] = [];
    const matches = await db
      .selectFrom('member')
      .innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id', 'member.status'])
      .where('member.organization_id', '=', organizationId)
      .where('person.anonymised_at', 'is', null)
      .where((eb) => eb(eb.fn('lower', ['person.email']), '=', p.email))
      .execute();
    const current = matches.filter((m) => CURRENT.includes(m.status));
    const pick = current.length === 1 ? current[0] : current.length === 0 && matches.length === 1 ? matches[0] : undefined;
    if (!matches.length) {
      rows.push({ email: p.email, action: 'skip', reason: 'Kein Mitglied mit dieser E-Mail-Adresse', notes });
      continue;
    }
    if (!pick) {
      rows.push({ email: p.email, action: 'skip', reason: 'Mehrere Mitgliedschaften mit dieser E-Mail-Adresse', notes });
      continue;
    }
    if (!(p.mode in MODE)) notes.push(`Unbekannter Modus „${p.mode}“: als kein öffentliches Profil übernommen`);
    if (p.photo && !imageTypeOf(p.photo)) notes.push('Foto ist kein JPG, PNG oder WebP: ausgelassen');
    if (p.photo && p.photo.length > 2 * 1024 * 1024) notes.push('Foto größer als 2 MB: ausgelassen');
    linksOf(p, notes);
    const existing = await db.selectFrom('member_profile').select('id').where('member_id', '=', pick.id).executeTakeFirst();
    rows.push({ email: p.email, action: existing ? 'update' : 'create', memberId: pick.id, notes });
  }
  return rows;
}

/**
 * Writes the planned profiles in one transaction: types Enthusiast and Profi added to the club if missing, content,
 * links, approval (as given in KI Klub), contact visibility and the photo as a member file. A photo is only shown
 * publicly once the member has the `photos` consent in OpenVerein; the report counts those without.
 */
export async function applyImport(db: Db, organizationId: string, source: SourceProfile[]) {
  const plan = await planImport(db, organizationId, source);
  let withoutConsent = 0;
  await db.transaction().execute(async (tx) => {
    const org = await tx.selectFrom('organization').select('profile_types').where('id', '=', organizationId).forUpdate().executeTakeFirstOrThrow();
    const types = [...org.profile_types];
    for (const t of KI_KLUB_TYPES) if (!types.some((x) => x.key === t.key)) types.push(t);
    await tx.updateTable('organization').set({ profile_types: JSON.stringify(types) as never }).where('id', '=', organizationId).execute();
    for (const [i, row] of plan.entries()) {
      if (row.action === 'skip') continue;
      const p = source[i]!;
      const notes: string[] = [];
      const typeKey = MODE[p.mode] ?? 'none';
      const values = {
        display_name: clip(p.displayName, 80),
        bio: clip(p.bio, 2000),
        place: clip(p.place, 80),
        organisation: clip(p.organisation, 120),
        type_key: typeKey,
        contact_visibility: VISIBILITY[p.visibility] ?? 'board',
        hidden: false,
        approved_at: p.approved && typeKey !== 'none' ? (p.approvedAt ?? new Date()) : null,
        approved_by: null,
        updated_at: new Date(),
      };
      await tx.insertInto('member_profile').values({ organization_id: organizationId, member_id: row.memberId!, ...values }).onConflict((oc) => oc.column('member_id').doUpdateSet(values)).execute();
      const profile = await tx.selectFrom('member_profile').select(['id', 'photo_file_id']).where('member_id', '=', row.memberId!).executeTakeFirstOrThrow();
      await tx.deleteFrom('member_profile_link').where('profile_id', '=', profile.id).execute();
      for (const [j, l] of linksOf(p, notes).entries()) await tx.insertInto('member_profile_link').values({ profile_id: profile.id, label: l.label, url: l.url, position: j }).execute();
      const type = p.photo ? imageTypeOf(p.photo) : null;
      if (p.photo && type && p.photo.length <= 2 * 1024 * 1024 && !profile.photo_file_id) {
        const sha = await putBlob(p.photo);
        const f = await tx.insertInto('file').values({ organization_id: organizationId, folder_id: null, member_id: row.memberId!, purpose: 'photo', sha256: sha, size_bytes: p.photo.length, mime_type: type, name: `Profilfoto.${type.split('/')[1]}`, retention_class: 'document', retain_until: null, uploaded_by: null }).returning('id').executeTakeFirstOrThrow();
        // The import keeps KI Klub's approval: the photo was part of the approved profile there.
        await tx.updateTable('member_profile').set({ photo_file_id: f.id, approved_at: values.approved_at }).where('id', '=', profile.id).execute();
        const consent = await tx.selectFrom('consent').innerJoin('member', 'member.person_id', 'consent.person_id').select('consent.id').where('member.id', '=', row.memberId!).where('consent.purpose', '=', 'photos').where('consent.withdrawn_at', 'is', null).executeTakeFirst();
        if (!consent) withoutConsent++;
      }
      await audit(tx, organizationId, null, { action: 'profile.imported', entityType: 'member_profile', entityId: profile.id, diff: { source: [null, 'KI Klub'], typeKey: [null, typeKey], approved: [null, !!values.approved_at] } });
    }
  });
  return { plan, withoutConsent };
}
