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

/**
 * The photo without the metadata a camera writes (EXIF with GPS, XMP, comments, colour profiles, text and private
 * chunks): a phone picture must not publish where the member lives. Only what draws the picture is kept (an
 * allowlist), plus the EXIF orientation so the photo stays upright. Returns null for a file whose structure doesn't
 * parse or that isn't a still image (animated WebP); such a file is refused, never stored or served raw.
 */
export function stripPhotoMetadata(bytes: Buffer, type: string): Buffer | null {
  try {
    if (type === 'image/jpeg') return stripJpeg(bytes);
    if (type === 'image/png') return stripPng(bytes);
    if (type === 'image/webp') return stripWebp(bytes);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
  }
  return null;
}

const segment = (marker: number, payload: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};

/** JPEG: every segment up to the end of the first image, through all scans; APPn and COM dropped everywhere. */
function stripJpeg(b: Buffer) {
  if (b.readUInt16BE(0) !== 0xffd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let i = 2;
  for (;;) {
    if (b.readUInt8(i) !== 0xff) return null;
    while (b.readUInt8(i) === 0xff) i++;
    const marker = b.readUInt8(i++);
    // The end of the image: anything after it (a second image, appended data) is not copied.
    if (marker === 0xd9) {
      if (orientation) out.splice(out[1]?.[1] === 0xe0 ? 2 : 1, 0, segment(0xe1, orientationExif(orientation)));
      return Buffer.concat([...out, Buffer.from([0xff, 0xd9])]);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(Buffer.from([0xff, marker]));
      continue;
    }
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) return null;
    const payload = b.subarray(i + 2, i + len);
    i += len;
    if (marker === 0xe0) {
      // JFIF keeps its density, never its thumbnail.
      if (payload.subarray(0, 5).toString('latin1') === 'JFIF\0' && payload.length >= 14) out.push(segment(0xe0, Buffer.concat([payload.subarray(0, 12), Buffer.from([0, 0])])));
    } else if (marker === 0xe1) {
      orientation ??= orientationOf(payload);
    } else if (marker === 0xee) {
      // Adobe's colour transform: CMYK photos are unreadable without it; it is a fixed 12-byte record.
      if (payload.subarray(0, 5).toString('latin1') === 'Adobe' && payload.length >= 12) out.push(segment(0xee, payload.subarray(0, 12)));
    } else if (!((marker >= 0xe2 && marker <= 0xef) || marker === 0xfe)) {
      out.push(segment(marker, payload));
    }
    if (marker === 0xda) {
      // The compressed scan runs to the next marker other than a stuffed 0xFF00 or a restart marker.
      const start = i;
      while (!(b.readUInt8(i) === 0xff && b.readUInt8(i + 1) !== 0 && !(b.readUInt8(i + 1) >= 0xd0 && b.readUInt8(i + 1) <= 0xd7))) i++;
      out.push(b.subarray(start, i));
    }
  }
}

/** The EXIF orientation (2–8) from an APP1 payload, if there is one and it isn't the default. */
function orientationOf(p: Buffer): number | null {
  if (p.subarray(0, 6).toString('latin1') !== 'Exif\0\0') return null;
  const t = p.subarray(6);
  const order = t.subarray(0, 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  for (let n = 0, count = u16(ifd); n < count; n++) {
    const e = ifd + 2 + n * 12;
    if (u16(e) === 0x0112 && u16(e + 2) === 3 && u32(e + 4) === 1) {
      const v = u16(e + 8);
      return v >= 2 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** An EXIF block holding nothing but the orientation (big-endian TIFF, one IFD entry). */
const orientationExif = (o: number) => Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0])]);

// The chunks that draw a still or animated PNG; everything else (text, eXIf, iCCP, tIME, private chunks) goes.
const PNG_KEEP = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT'];

function stripPng(b: Buffer) {
  const out: Buffer[] = [b.subarray(0, 8)];
  for (let i = 8; ; ) {
    const len = b.readUInt32BE(i);
    const kind = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (PNG_KEEP.includes(kind)) out.push(b.subarray(i, end));
    if (kind === 'IEND') return Buffer.concat(out);
    i = end;
  }
}

/** WebP: still images only; the image and alpha chunks kept, every other chunk dropped, VP8X flags to match. */
function stripWebp(b: Buffer) {
  const size = b.readUInt32LE(4);
  if (8 + size !== b.length || size % 2) return null;
  const out: Buffer[] = [];
  for (let i = 12; i < b.length; ) {
    const kind = b.subarray(i, i + 4).toString('latin1');
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (end > b.length) return null;
    if (kind === 'ANIM' || kind === 'ANMF') return null;
    if (kind === 'VP8X') {
      const chunk = Buffer.from(b.subarray(i, end));
      chunk[8] = chunk.readUInt8(8) & 0x10; // only the alpha flag survives: no ICC, EXIF, XMP or animation
      out.push(chunk);
    } else if (kind === 'VP8 ' || kind === 'VP8L' || kind === 'ALPH') out.push(b.subarray(i, end));
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}
