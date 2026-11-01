import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../db.ts';
import { Problem } from '../http/problem.ts';
import type { ProfileDto, profileInput } from '../../shared/profiles.ts';

/** Memberships whose profile can be public. */
const CURRENT = ['active', 'resigned'] as const;

/** The club's types; malformed entries (hand-edited data) are left out rather than breaking a page. */
export async function profileTypes(db: Db, organizationId: string) {
  const raw = (await db.selectFrom('organization').select('profile_types').where('id', '=', organizationId).executeTakeFirstOrThrow()).profile_types as unknown;
  const list = Array.isArray(raw) ? raw : [];
  return list.filter((t): t is { key: string; label: string } => !!t && typeof t.key === 'string' && /^[a-z0-9_-]{1,40}$/.test(t.key) && t.key !== 'none' && typeof t.label === 'string' && !!t.label).slice(0, 20);
}

export async function hasPhotoConsent(db: Db, personId: string) {
  return !!(await db.selectFrom('consent').select('id').where('person_id', '=', personId).where('purpose', '=', 'photos').where('withdrawn_at', 'is', null).executeTakeFirst());
}

/** Public = a type, the board's approval of this version, not hidden, and a current membership. */
export const isPublic = (p: { type_key: string; approved_at: Date | null; hidden: boolean }, memberStatus: string) =>
  p.type_key !== 'none' && !!p.approved_at && !p.hidden && (CURRENT as readonly string[]).includes(memberStatus);

/** A member's profile as the portal (or the board) sees it; an empty one when none was saved yet. */
export async function profileOf(db: Db, organizationId: string, memberId: string): Promise<ProfileDto> {
  const m = await db.selectFrom('member').select(['person_id', 'status']).where('id', '=', memberId).where('organization_id', '=', organizationId).executeTakeFirstOrThrow();
  const p = await db.selectFrom('member_profile').leftJoin('file', 'file.id', 'member_profile.photo_file_id').selectAll('member_profile').select(['file.size_bytes', 'file.mime_type']).where('member_profile.member_id', '=', memberId).executeTakeFirst();
  const links = p ? await db.selectFrom('member_profile_link').select(['label', 'url']).where('profile_id', '=', p.id).orderBy('position').execute() : [];
  return {
    memberId,
    displayName: p?.display_name ?? null,
    bio: p?.bio ?? null,
    place: p?.place ?? null,
    organisation: p?.organisation ?? null,
    links,
    typeKey: p?.type_key ?? 'none',
    contactVisibility: p?.contact_visibility ?? 'board',
    hidden: p?.hidden ?? false,
    photo: p?.photo_file_id && p.size_bytes !== null ? { size: Number(p.size_bytes), type: p.mime_type! } : null,
    approved: !!p?.approved_at,
    public: !!p && isPublic(p, m.status),
    photoConsent: await hasPhotoConsent(db, m.person_id),
    types: await profileTypes(db, organizationId),
  };
}

/** Locks (or creates) the profile row of a membership. */
async function lockedProfile(tx: Db, organizationId: string, memberId: string) {
  await tx.insertInto('member_profile').values({ organization_id: organizationId, member_id: memberId }).onConflict((oc) => oc.column('member_id').doNothing()).execute();
  return tx.selectFrom('member_profile').selectAll().where('member_id', '=', memberId).where('organization_id', '=', organizationId).forUpdate().executeTakeFirstOrThrow();
}

const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Saves the member's profile. Approval belongs to one version: a change to what the public sees (name, bio, place,
 * organisation, links, type) clears it, so the profile goes back to the board. Hiding and the contact switch do not.
 */
export async function saveProfile(tx: Db, organizationId: string, memberId: string, b: z.infer<typeof profileInput>) {
  // Lock order: club row, then profile; a type removal cannot slip between this check and the write.
  await tx.selectFrom('organization').select('id').where('id', '=', organizationId).forShare().execute();
  const types = await profileTypes(tx, organizationId);
  if (b.typeKey !== 'none' && !types.some((t) => t.key === b.typeKey)) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'typeKey', message: 'Diese Profilart gibt es im Verein nicht.' }] });
  const p = await lockedProfile(tx, organizationId, memberId);
  const oldLinks = await tx.selectFrom('member_profile_link').select(['label', 'url']).where('profile_id', '=', p.id).orderBy('position').execute();
  const before = fingerprint([p.display_name, p.bio, p.place, p.organisation, p.type_key, oldLinks]);
  const after = fingerprint([b.displayName, b.bio, b.place, b.organisation, b.typeKey, b.links.map((l) => ({ label: l.label, url: l.url }))]);
  const changed = before !== after;
  await tx
    .updateTable('member_profile')
    .set({ display_name: b.displayName, bio: b.bio, place: b.place, organisation: b.organisation, type_key: b.typeKey, contact_visibility: b.contactVisibility, hidden: b.hidden, updated_at: new Date(), ...(changed ? { approved_at: null, approved_by: null } : {}) })
    .where('id', '=', p.id)
    .execute();
  if (changed) {
    await tx.deleteFrom('member_profile_link').where('profile_id', '=', p.id).execute();
    for (const [i, l] of b.links.entries()) await tx.insertInto('member_profile_link').values({ profile_id: p.id, label: l.label, url: l.url, position: i }).execute();
  }
  return { id: p.id, changed };
}

/** Sets or removes the photo (a member file); a new photo is a new version for the board. Returns the old file to delete. */
export async function setPhoto(tx: Db, organizationId: string, memberId: string, fileId: string | null) {
  const p = await lockedProfile(tx, organizationId, memberId);
  // Any photo change, removal included, is a new version.
  const changed = p.photo_file_id !== fileId;
  await tx.updateTable('member_profile').set({ photo_file_id: fileId, updated_at: new Date(), ...(changed ? { approved_at: null, approved_by: null } : {}) }).where('id', '=', p.id).execute();
  return p.photo_file_id;
}

/** JPEG, PNG or WebP by their first bytes (the declared type is not trusted). */
export function imageTypeOf(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
