import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { profileDto, profileType } from '../../shared/profiles.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { getBlob } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { profileOf, profileTypes, stripPhotoMetadata } from '../profiles/service.ts';
import { requireClubWide } from '../policy.ts';
import { baseUrlOf, tenantForRequest } from '../tenant.ts';

const tags = ['members'];
const PUBLIC_STATUSES = ['active', 'resigned'] as const;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const queueItem = z.object({
  memberId: z.uuid(),
  memberName: z.string(),
  membershipNumber: z.string(),
  typeKey: z.string(),
  typeLabel: z.string().nullable(),
  approved: z.boolean(),
  hidden: z.boolean(),
  public: z.boolean(),
  updatedAt: z.string(),
});

const typesInput = z
  .array(z.object({ key: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Kleinbuchstaben, Ziffern, - und _.').refine((k) => k !== 'none', 'Diesen Schlüssel gibt es schon (kein Profil).'), label: z.string().trim().min(1).max(60) }))
  .max(20)
  .refine((l) => new Set(l.map((t) => t.key)).size === l.length, 'Jeder Schlüssel nur einmal.');

/**
 * Public member profiles (change public-profiles, slice 2): the board's approval queue, the club's profile types,
 * and the public feed a club website reads. A profile is public only with a type, the board's approval of its
 * current version, not hidden, and a current membership; its photo only with the `photos` consent.
 */
export const profileRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.db;

  // ---------- Board ----------

  app.get('/profiles', { schema: { tags, summary: 'Profile der Mitglieder: wartende (Standard), öffentliche oder alle', querystring: z.object({ status: z.enum(['waiting', 'public', 'all']).default('waiting') }), response: { 200: z.array(queueItem) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const types = await profileTypes(db, actor.organizationId);
    let q = db
      .selectFrom('member_profile')
      .innerJoin('member', 'member.id', 'member_profile.member_id')
      .innerJoin('person', 'person.id', 'member.person_id')
      .select(['member_profile.member_id', 'member_profile.type_key', 'member_profile.approved_at', 'member_profile.hidden', 'member_profile.updated_at', 'member.status', 'member.membership_number', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('member_profile.organization_id', '=', actor.organizationId);
    if (req.query.status === 'waiting') q = q.where('member_profile.type_key', '<>', 'none').where('member_profile.approved_at', 'is', null).where('member_profile.hidden', '=', false);
    if (req.query.status === 'public') q = q.where('member_profile.type_key', '<>', 'none').where('member_profile.approved_at', 'is not', null).where('member_profile.hidden', '=', false).where('member.status', 'in', [...PUBLIC_STATUSES]);
    const rows = await q.orderBy('member_profile.updated_at', 'desc').limit(500).execute();
    return rows.map((r) => ({
      memberId: r.member_id,
      memberName: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.company_name || '—',
      membershipNumber: r.membership_number,
      typeKey: r.type_key,
      typeLabel: types.find((t) => t.key === r.type_key)?.label ?? null,
      approved: !!r.approved_at,
      hidden: r.hidden,
      public: r.type_key !== 'none' && !!r.approved_at && !r.hidden && (PUBLIC_STATUSES as readonly string[]).includes(r.status),
      updatedAt: r.updated_at.toISOString(),
    }));
  });

  app.get('/members/:id/profile', { schema: { tags, summary: 'Profil eines Mitglieds (wie das Mitglied es zuletzt gespeichert hat)', params: z.object({ id: z.uuid() }), response: { 200: profileDto.extend({ updatedAt: z.string().nullable() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const m = await db.selectFrom('member').select('id').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!m) throw notFound('Mitglied');
    const updatedAt = (await db.selectFrom('member_profile').select('updated_at').where('member_id', '=', m.id).executeTakeFirst())?.updated_at.toISOString() ?? null;
    return { ...(await profileOf(db, actor.organizationId, m.id)), updatedAt };
  });

  app.get('/members/:id/profile/photo', { schema: { tags, summary: 'Profilfoto eines Mitglieds (zur Prüfung vor der Freigabe)', params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const f = await db.selectFrom('member_profile').innerJoin('file', 'file.id', 'member_profile.photo_file_id').select(['file.sha256', 'file.mime_type']).where('member_profile.member_id', '=', req.params.id).where('member_profile.organization_id', '=', actor.organizationId).where('file.purpose', '=', 'photo').executeTakeFirst();
    if (!f || !PHOTO_TYPES.includes(f.mime_type)) throw notFound('Foto');
    return reply.headers({ 'content-type': f.mime_type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' }).send(await getBlob(f.sha256));
  });

  // The board approves exactly the version it read: the member may have changed it since.
  const decision = z.object({ updatedAt: z.string() });

  app.post('/profiles/:memberId/approve', { schema: { tags, summary: 'Profil freigeben (genau die gelesene Fassung; danach öffentlich, solange nicht verborgen)', params: z.object({ memberId: z.uuid() }), body: decision, response: { 200: z.object({ public: z.boolean() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    return db.transaction().execute(async (tx) => {
      // Club row first (the lock order of type changes and saves): the type cannot disappear meanwhile.
      const types = (await tx.selectFrom('organization').select('profile_types').where('id', '=', actor.organizationId).forShare().executeTakeFirstOrThrow()).profile_types;
      const p = await tx.selectFrom('member_profile').innerJoin('member', 'member.id', 'member_profile.member_id').select(['member_profile.id', 'member_profile.type_key', 'member_profile.hidden', 'member_profile.updated_at', 'member.status']).where('member_profile.member_id', '=', req.params.memberId).where('member_profile.organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!p) throw notFound('Profil');
      if (p.updated_at.toISOString() !== req.body.updatedAt) throw new Problem(409, 'profile-changed', 'Das Mitglied hat das Profil inzwischen geändert.', 'Lies die neue Fassung und gib sie dann frei.');
      if (p.type_key !== 'none' && !types.some((t) => t.key === p.type_key)) throw new Problem(409, 'profile-no-type', 'Diese Profilart gibt es im Verein nicht mehr.');
      if (p.type_key === 'none') throw new Problem(409, 'profile-no-type', 'Das Mitglied hat keine Profilart gewählt; ein solches Profil wird nicht veröffentlicht.');
      await tx.updateTable('member_profile').set({ approved_at: new Date(), approved_by: actor.userId }).where('id', '=', p.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'profile.approved', entityType: 'member_profile', entityId: p.id });
      return { public: !p.hidden && (PUBLIC_STATUSES as readonly string[]).includes(p.status) };
    });
  });

  app.post('/profiles/:memberId/revoke', { schema: { tags, summary: 'Freigabe zurücknehmen (das Profil ist sofort nicht mehr öffentlich)', params: z.object({ memberId: z.uuid() }), body: z.object({}).optional(), response: { 200: z.object({ public: z.boolean() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('member_profile').set({ approved_at: null, approved_by: null }).where('member_id', '=', req.params.memberId).where('organization_id', '=', actor.organizationId).returning('id').executeTakeFirst();
      if (!r) throw notFound('Profil');
      await audit(tx, actor.organizationId, actor, { action: 'profile.revoked', entityType: 'member_profile', entityId: r.id });
    });
    return { public: false };
  });

  app.get('/profile-types', { schema: { tags, summary: 'Profilarten des Vereins', response: { 200: z.array(profileType) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    return profileTypes(db, actor.organizationId);
  });

  app.put('/profile-types', { schema: { tags: ['organization'], summary: 'Profilarten festlegen; eine entfernte Art nimmt ihre Profile aus der Öffentlichkeit', body: z.object({ types: typesInput }), response: { 200: z.array(profileType) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'settings', 'write');
    const keys = req.body.types.map((t) => t.key);
    await db.transaction().execute(async (tx) => {
      await tx.selectFrom('organization').select('id').where('id', '=', actor.organizationId).forUpdate().execute();
      const before = await profileTypes(tx, actor.organizationId);
      await tx.updateTable('organization').set({ profile_types: JSON.stringify(req.body.types) as never }).where('id', '=', actor.organizationId).execute();
      // A type that no longer exists publishes nothing: its profiles go to "none" (and so need a new approval).
      let gone = tx.updateTable('member_profile').set({ type_key: 'none', approved_at: null, approved_by: null }).where('organization_id', '=', actor.organizationId).where('type_key', '<>', 'none');
      if (keys.length) gone = gone.where('type_key', 'not in', keys);
      const moved = await gone.execute();
      await audit(tx, actor.organizationId, actor, { action: 'profile_types.updated', entityType: 'organization', entityId: actor.organizationId, diff: { types: [before, req.body.types], profilesUnpublished: [null, Number(moved[0]?.numUpdatedRows ?? 0)] } });
    });
    return profileTypes(db, actor.organizationId);
  });

  // ---------- Public feed ----------

  const publicProfile = z.object({
    id: z.uuid(),
    type: z.string(),
    typeLabel: z.string(),
    name: z.string(),
    bio: z.string().nullable(),
    place: z.string().nullable(),
    organisation: z.string().nullable(),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
    photoUrl: z.string().nullable(),
    email: z.string().nullable(),
  });

  /**
   * Public profiles of the club behind this host, with photo only under the `photos` consent. One statement reads
   * profile, links and photo, so a save in between cannot mix an approved text with unapproved links.
   */
  async function publicProfiles(organizationId: string, base: string, onlyId?: string) {
    const types = await profileTypes(db, organizationId);
    let q = db
      .selectFrom('member_profile')
      .innerJoin('member', 'member.id', 'member_profile.member_id')
      .innerJoin('person', 'person.id', 'member.person_id')
      .leftJoin('file', (j) => j.onRef('file.id', '=', 'member_profile.photo_file_id').onRef('file.member_id', '=', 'member_profile.member_id').on('file.purpose', '=', 'photo').on('file.mime_type', 'in', PHOTO_TYPES))
      .select([
        'member_profile.id', 'member_profile.type_key', 'member_profile.display_name', 'member_profile.bio', 'member_profile.place', 'member_profile.organisation', 'member_profile.contact_visibility',
        'person.first_name', 'person.last_name', 'person.company_name', 'person.email', 'file.sha256', 'file.mime_type',
        sql<boolean>`exists (select 1 from consent c where c.person_id = person.id and c.purpose = 'photos' and c.withdrawn_at is null)`.as('photo_consent'),
        sql<{ label: string; url: string }[]>`coalesce((select jsonb_agg(jsonb_build_object('label', l.label, 'url', l.url) order by l.position) from member_profile_link l where l.profile_id = member_profile.id), '[]'::jsonb)`.as('links'),
      ])
      .where('member_profile.organization_id', '=', organizationId)
      .where('member_profile.type_key', '<>', 'none')
      .where('member_profile.approved_at', 'is not', null)
      .where('member_profile.hidden', '=', false)
      .where('member.status', 'in', [...PUBLIC_STATUSES])
      .where('person.anonymised_at', 'is', null);
    if (onlyId) q = q.where('member_profile.id', '=', onlyId);
    const rows = await q.orderBy(sql`lower(coalesce(member_profile.display_name, person.last_name))`).execute();
    return rows
      .filter((r) => types.some((t) => t.key === r.type_key))
      .map((r) => ({
        id: r.id,
        type: r.type_key,
        typeLabel: types.find((t) => t.key === r.type_key)!.label,
        name: r.display_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.company_name || '',
        bio: r.bio,
        place: r.place,
        organisation: r.organisation,
        links: r.links,
        // The hash is a cache buster when the photo changes; the cache stays short, so a withdrawal takes effect soon.
        photoUrl: r.sha256 && r.photo_consent ? `${base}/api/v1/public/profiles/${r.id}/photo?v=${r.sha256.slice(0, 16)}` : null,
        email: r.contact_visibility === 'public' ? r.email : null,
        photo: r.sha256 && r.photo_consent ? { sha256: r.sha256, type: r.mime_type! } : null,
      }));
  }

  // Readable by any website (no credentials), cached for five minutes, limited per address.
  const publicHeaders = { 'cache-control': 'public, max-age=300' };
  const limited = { config: { rateLimit: { max: 120, timeWindow: '1 minute' }, publicCors: true } };
  // Every answer of these routes, errors and 429 included, so a website sees the real status.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.config?.publicCors) reply.header('access-control-allow-origin', '*');
    return payload;
  });

  app.get('/public/profiles', { ...limited, schema: { tags: ['public'], summary: 'Öffentliche Profile des Vereins (für die Website; nur freigegebene)', security: [], response: { 200: z.object({ profiles: z.array(publicProfile) }), 304: z.null() } } }, async (req, reply) => {
    const org = await tenantForRequest(db, req);
    if (!org) throw notFound('Verein');
    // Absolute photo addresses: the feed is read from the club's own website, on another host.
    const body = { profiles: (await publicProfiles(org.id, baseUrlOf(org))).map(({ photo: _, ...p }) => p) };
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
    reply.headers({ ...publicHeaders, etag });
    if (req.headers['if-none-match'] === etag) return reply.status(304).send(null);
    return body;
  });

  app.get('/public/profiles/:id/photo', { ...limited, schema: { tags: ['public'], summary: 'Foto eines öffentlichen Profils (nur mit Einwilligung „Fotos“)', security: [], params: z.object({ id: z.uuid() }), querystring: z.object({ v: z.string().max(64).optional() }) } }, async (req, reply) => {
    const org = await tenantForRequest(db, req);
    if (!org) throw notFound('Verein');
    // The photo of exactly the public version, decided in the same read as its publication.
    const [p] = await publicProfiles(org.id, baseUrlOf(org), req.params.id);
    const f = p?.photo;
    // An old address (another photo's hash) never serves the new photo.
    if (!f || !PHOTO_TYPES.includes(f.type) || (req.query.v && !f.sha256.startsWith(req.query.v))) throw notFound('Foto');
    // The served bytes are the cleaned photo, so they get their own tag: a cache holding an uncleaned copy under
    // the stored hash never gets it confirmed.
    const etag = `"clean1-${f.sha256}"`;
    reply.headers({ ...publicHeaders, etag, 'content-type': f.type, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cross-origin-resource-policy': 'cross-origin' });
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    // Stripped again on the way out: photos stored before uploads were cleaned carry their metadata.
    const clean = stripPhotoMetadata(await getBlob(f.sha256), f.type);
    if (!clean) throw notFound('Foto');
    return reply.send(clean);
  });
};
