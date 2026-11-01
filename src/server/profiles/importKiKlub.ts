import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import type { Db } from '../db.ts';
import { audit } from '../audit.ts';
import { putBlob } from '../files/store.ts';
import { lockErasures } from '../gdpr/service.ts';
import { imageTypeOf, stripPhotoMetadata } from './service.ts';

/**
 * Import of KI Klub Werder profiles (change public-profiles, slice 3): klub_profil with its links and photo
 * (bytea), matched to members of an OpenVerein club by e-mail. Dry run first: `plan` reports, `apply` writes.
 * Never run against KI Klub production from here; Tim migrates after his own test.
 */
export interface SourceProfile {
  sourceId: string;
  email: string;
  /** klub_mitglied.status: aktiv, ruhend or ausgetreten */
  status: string;
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
// KI Klub never put an e-mail address in its public feed: "oeffentlich" becomes "members", never "public".
const VISIBILITY: Record<string, 'board' | 'members'> = { vorstand: 'board', mitglieder: 'members', oeffentlich: 'members' };

/** Reads the KI Klub tables (klub_mitglied, klub_profil, klub_profil_link) from a database, optionally a schema. */
export async function readKiKlub(connectionString: string, schema = 'public'): Promise<SourceProfile[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const s = client.escapeIdentifier(schema);
    const profiles = await client.query(`
      select p.id, lower(btrim(m.email)) as email, m.status, p.anzeigename, p.bio, p.ort, p.organisation, p.linkedin_url, p.profil_modus,
             p.profi_freigabe, p.profi_freigabe_am, p.sichtbarkeit_kontakt, p.foto
      from ${s}.klub_profil p join ${s}.klub_mitglied m on m.id = p.mitglied_id order by p.id`);
    const links = await client.query(`select profil_id, label, url from ${s}.klub_profil_link order by profil_id, sortierung, id`);
    return profiles.rows.map((r) => ({
      sourceId: r.id,
      email: r.email,
      status: r.status ?? 'aktiv',
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

/** One planned profile: what it becomes in OpenVerein, so the person confirming sees exactly what goes public. */
export interface PlannedRow {
  sourceId: string;
  email: string;
  action: 'create' | 'skip';
  reason?: string;
  memberId?: string;
  memberName?: string;
  typeKey?: string;
  approved?: boolean;
  visibility?: 'board' | 'members';
  links?: { label: string; url: string }[];
  photo?: boolean;
  notes: string[];
}

const clip = (v: string | null, n: number) => (v && v.trim() ? v.trim().slice(0, n) : null);

/** The links as OpenVerein keeps them: the LinkedIn field first (unless already a link), at most 10, http(s) only. */
function linksOf(p: SourceProfile, notes: string[]) {
  const all = [...(p.linkedinUrl && !p.links.some((l) => l.url === p.linkedinUrl) ? [{ label: 'LinkedIn', url: p.linkedinUrl }] : []), ...p.links];
  const valid = (u: string) => {
    try {
      return ['http:', 'https:'].includes(new URL(u.trim()).protocol) && u.trim().length <= 500;
    } catch {
      return false;
    }
  };
  const ok = all.filter((l) => valid(l.url) && l.label.trim()).map((l) => ({ label: l.label.trim().slice(0, 60), url: l.url.trim() }));
  if (ok.length < all.length) notes.push(`${all.length - ok.length} Link(s) ohne gültige http(s)-Adresse ausgelassen`);
  if (ok.length > 10) notes.push(`${ok.length - 10} Link(s) über der Grenze von 10 ausgelassen`);
  return ok.slice(0, 10);
}

const cleanPhoto = (p: SourceProfile) => {
  const type = p.photo && p.photo.length <= 2 * 1024 * 1024 ? imageTypeOf(p.photo) : null;
  const bytes = type ? stripPhotoMetadata(p.photo!, type) : null;
  return type && bytes ? { type, bytes } : null;
};
const photoOk = (p: SourceProfile) => !!cleanPhoto(p);

/**
 * What the import would do, per KI Klub profile; writes nothing. A one-time migration: a member who already has
 * an OpenVerein profile is left alone (no overwrite of later choices), and e-mail matching must be unambiguous.
 */
export async function planImport(db: Db, organizationId: string, source: SourceProfile[]): Promise<PlannedRow[]> {
  const rows: PlannedRow[] = [];
  for (const p of source) {
    const notes: string[] = [];
    const base = { sourceId: p.sourceId, email: p.email, notes };
    if (p.status === 'ausgetreten') {
      rows.push({ ...base, action: 'skip', reason: 'Im KI Klub ausgetreten' });
      continue;
    }
    // The address is the only key: exactly one person of the club may have it, whatever their status.
    const matches = await db
      .selectFrom('member')
      .innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id', 'member.status', 'person.first_name', 'person.last_name'])
      .where('member.organization_id', '=', organizationId)
      .where('person.anonymised_at', 'is', null)
      .where(sql<boolean>`lower(btrim(person.email)) = ${p.email}`)
      .execute();
    if (!matches.length) {
      rows.push({ ...base, action: 'skip', reason: 'Kein Mitglied mit dieser E-Mail-Adresse' });
      continue;
    }
    if (matches.length > 1) {
      rows.push({ ...base, action: 'skip', reason: 'Mehrere Mitgliedschaften mit dieser E-Mail-Adresse' });
      continue;
    }
    const m = matches[0]!;
    if (!['active', 'resigned', 'future'].includes(m.status)) {
      rows.push({ ...base, action: 'skip', reason: `Mitgliedschaft in OpenVerein nicht aktuell (${m.status})` });
      continue;
    }
    if (await db.selectFrom('member_profile').select('id').where('member_id', '=', m.id).executeTakeFirst()) {
      rows.push({ ...base, action: 'skip', reason: 'Hat in OpenVerein schon ein Profil (wird nicht überschrieben)' });
      continue;
    }
    if (!(p.mode in MODE)) notes.push(`Unbekannter Modus „${p.mode}“: als kein öffentliches Profil übernommen`);
    if (p.photo && !photoOk(p)) notes.push('Foto ist kein JPG, PNG oder WebP bis 2 MB: ausgelassen');
    if (p.visibility === 'oeffentlich') notes.push('Kontakt „öffentlich“ wird zu „Mitglieder“ (der KI Klub zeigte die Adresse nie öffentlich)');
    const typeKey = MODE[p.mode] ?? 'none';
    // Public in KI Klub only with mode, approval and an active membership: the same here.
    const approved = p.approved && typeKey !== 'none' && p.status === 'aktiv';
    if (p.approved && p.status !== 'aktiv') notes.push(`Im KI Klub „${p.status}“: ohne Freigabe übernommen`);
    rows.push({ ...base, action: 'create', memberId: m.id, memberName: [m.first_name, m.last_name].filter(Boolean).join(' '), typeKey, approved, visibility: VISIBILITY[p.visibility] ?? 'board', links: linksOf(p, notes), photo: photoOk(p) });
  }
  return rows;
}

/** A digest of the plan and the source content: the confirmation must name it, so only the reviewed plan is written. */
export function planDigest(plan: PlannedRow[], source: SourceProfile[]) {
  const content = source.map((p) => [p.sourceId, p.displayName, p.bio, p.place, p.organisation, p.photo ? createHash('sha256').update(p.photo).digest('hex') : null]);
  return createHash('sha256').update(JSON.stringify([plan, content])).digest('hex').slice(0, 12);
}

/**
 * Writes the reviewed plan in one transaction, under the club's erasure lock: the plan is computed again inside it
 * and must have the confirmed digest (nothing changed since the dry run, and nobody erased meanwhile).
 */
export async function applyImport(db: Db, organizationId: string, source: SourceProfile[], confirmedDigest: string) {
  return db.transaction().execute(async (tx) => {
    await lockErasures(tx, organizationId);
    const org = await tx.selectFrom('organization').select('profile_types').where('id', '=', organizationId).forUpdate().executeTakeFirstOrThrow();
    const plan = await planImport(tx, organizationId, source);
    if (planDigest(plan, source) !== confirmedDigest) throw new Error('Der Plan hat sich seit dem Probelauf geändert. Bitte den Probelauf wiederholen und den neuen Code bestätigen.');
    let withoutConsent = 0;
    if (plan.some((r) => r.action === 'create')) {
      const before = org.profile_types;
      const types = [...before];
      for (const t of KI_KLUB_TYPES) if (!types.some((x) => x.key === t.key)) types.push(t);
      if (types.length !== before.length) {
        await tx.updateTable('organization').set({ profile_types: JSON.stringify(types) as never }).where('id', '=', organizationId).execute();
        await audit(tx, organizationId, null, { action: 'profile_types.updated', entityType: 'organization', entityId: organizationId, diff: { types: [before, types], source: [null, 'KI Klub import'] } });
      }
    }
    for (const [i, row] of plan.entries()) {
      if (row.action !== 'create') continue;
      const p = source[i]!;
      const created = await tx
        .insertInto('member_profile')
        .values({ organization_id: organizationId, member_id: row.memberId!, display_name: clip(p.displayName, 80), bio: clip(p.bio, 2000), place: clip(p.place, 80), organisation: clip(p.organisation, 120), type_key: row.typeKey!, contact_visibility: row.visibility!, hidden: false, approved_at: row.approved ? (p.approvedAt ?? new Date()) : null })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const [j, l] of row.links!.entries()) await tx.insertInto('member_profile_link').values({ profile_id: created.id, label: l.label, url: l.url, position: j }).execute();
      if (row.photo) {
        // Stored without camera metadata, like an upload.
        const { type, bytes } = cleanPhoto(p)!;
        const sha = await putBlob(bytes);
        const f = await tx.insertInto('file').values({ organization_id: organizationId, folder_id: null, member_id: row.memberId!, purpose: 'photo', sha256: sha, size_bytes: bytes.length, mime_type: type, name: `Profilfoto.${type.split('/')[1]}`, retention_class: 'document', retain_until: null, uploaded_by: null }).returning('id').executeTakeFirstOrThrow();
        // The photo was part of the profile KI Klub published: it keeps the profile's approval.
        await tx.updateTable('member_profile').set({ photo_file_id: f.id }).where('id', '=', created.id).execute();
        const consent = await tx.selectFrom('consent').innerJoin('member', 'member.person_id', 'consent.person_id').select('consent.id').where('member.id', '=', row.memberId!).where('consent.purpose', '=', 'photos').where('consent.withdrawn_at', 'is', null).executeTakeFirst();
        if (!consent) withoutConsent++;
      }
      await audit(tx, organizationId, null, { action: 'profile.imported', entityType: 'member_profile', entityId: created.id, diff: { source: [null, `KI Klub ${p.sourceId}`], typeKey: [null, row.typeKey], approved: [null, row.approved], contactVisibility: [null, row.visibility], links: [null, row.links!.length], photo: [null, row.photo] } });
    }
    return { plan, withoutConsent };
  });
}
