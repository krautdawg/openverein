import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { group, groupFields, groupPatch, membershipCreate, membershipPatch } from '../../shared/groups.ts';
import { memberListItem } from '../../shared/members.ts';
import { audit, diffOf } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { ClubGroupTable } from '../db.ts';
import { CONSTRAINT_MESSAGES, notFound, Problem } from '../http/problem.ts';
import { applyScope, currentGroups, loadMemberRow, memberColumns, orgToday, toListItem } from '../members/query.ts';
import { requirePermission, restrictedFields, type Actor } from '../policy.ts';
import { assertGroup } from './members.ts';

CONSTRAINT_MESSAGES.club_group_code_key = 'Dieses Kürzel ist schon vergeben.';
CONSTRAINT_MESSAGES.group_membership_member_id_group_id_daterange_excl = 'In diesem Zeitraum ist das Mitglied schon in der Gruppe.';

const idParam = z.object({ id: z.uuid() });
const tags = ['groups'];

const toDto = (g: Selectable<ClubGroupTable>, memberCount: number) => ({
  id: g.id,
  name: g.name,
  shortCode: g.short_code,
  kind: g.kind,
  color: g.color,
  parentId: g.parent_id,
  visibleToMembers: g.visible_to_members,
  inApplicationForm: g.in_application_form,
  archived: g.archived_at !== null,
  memberCount,
});

const columns = (b: Partial<z.infer<typeof groupFields>>) => {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.shortCode !== undefined) out.short_code = b.shortCode;
  if (b.kind !== undefined) out.kind = b.kind;
  if (b.color !== undefined) out.color = b.color;
  if (b.parentId !== undefined) out.parent_id = b.parentId;
  if (b.visibleToMembers !== undefined) out.visible_to_members = b.visibleToMembers;
  if (b.inApplicationForm !== undefined) out.in_application_form = b.inApplicationForm;
  return out;
};

export const groupRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function loadGroup(actor: Actor, id: string) {
    const g = await db.selectFrom('club_group').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!g) throw notFound('Gruppe');
    return g;
  }

  async function withCount(actor: Actor, g: Selectable<ClubGroupTable>) {
    const today = await orgToday(db, actor.organizationId);
    const n = await db
      .selectFrom('group_membership')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('group_id', '=', g.id)
      .where('valid_from', '<=', today)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', today)]))
      .executeTakeFirstOrThrow();
    return toDto(g, n.n);
  }

  async function checkParent(actor: Actor, parentId: string | null | undefined, selfId?: string) {
    if (!parentId) return;
    if (parentId === selfId) throw new Problem(400, 'invalid-parent', 'Eine Gruppe kann nicht ihre eigene Obergruppe sein.');
    const parent = await loadGroup(actor, parentId);
    // One level of nesting is enough (spec): a parent must not have a parent itself.
    if (parent.parent_id) throw new Problem(400, 'invalid-parent', 'Obergruppen dürfen selbst keine Obergruppe haben.');
  }

  app.get('/groups', { schema: { tags, summary: 'Gruppen und Abteilungen mit aktueller Mitgliederzahl', querystring: z.object({ includeArchived: z.coerce.boolean().optional() }), response: { 200: z.array(group) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'groups', 'read');
    const today = await orgToday(db, actor.organizationId);
    let q = db
      .selectFrom('club_group')
      .selectAll('club_group')
      .select((eb) =>
        eb
          .selectFrom('group_membership')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('group_membership.group_id', '=', 'club_group.id')
          .where('group_membership.valid_from', '<=', today)
          .where((w) => w.or([w('group_membership.valid_to', 'is', null), w('group_membership.valid_to', '>=', today)]))
          .as('member_count'),
      )
      .where('organization_id', '=', actor.organizationId);
    if (!req.query.includeArchived) q = q.where('archived_at', 'is', null);
    const rows = await q.orderBy('kind').orderBy('name').execute();
    return rows.map((r) => toDto(r, r.member_count ?? 0));
  });

  app.post('/groups', { schema: { tags, summary: 'Gruppe anlegen', body: groupFields, response: { 201: group } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'groups', 'write');
    await checkParent(actor, req.body.parentId);
    const g = await db.transaction().execute(async (tx) => {
      const g = await tx.insertInto('club_group').values({ organization_id: actor.organizationId, ...(columns(req.body) as { name: string; short_code: string }) }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'group.created', entityType: 'club_group', entityId: g.id, diff: { name: [null, g.name] } });
      return g;
    });
    reply.status(201);
    return toDto(g, 0);
  });

  app.patch('/groups/:id', { schema: { tags, summary: 'Gruppe ändern', params: idParam, body: groupPatch, response: { 200: group } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'groups', 'write');
    const before = await loadGroup(actor, req.params.id);
    await checkParent(actor, req.body.parentId, before.id);
    const values = columns(req.body);
    const g = await db.transaction().execute(async (tx) => {
      const g = await tx.updateTable('club_group').set({ ...values, updated_at: new Date() }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'group.updated', entityType: 'club_group', entityId: g.id, diff: diffOf(before as Record<string, unknown>, values) });
      return g;
    });
    return withCount(actor, g);
  });

  for (const [path, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/groups/:id/${path}`, { schema: { tags, summary: archived ? 'Gruppe archivieren (Verlauf bleibt erhalten)' : 'Gruppe wiederherstellen', params: idParam, body: z.object({}).optional(), response: { 200: group } } }, async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'groups', 'write');
      await loadGroup(actor, req.params.id);
      const g = await db.transaction().execute(async (tx) => {
        const g = await tx.updateTable('club_group').set({ archived_at: archived ? new Date() : null, updated_at: new Date() }).where('id', '=', req.params.id).returningAll().executeTakeFirstOrThrow();
        await audit(tx, actor.organizationId, actor, { action: archived ? 'group.archived' : 'group.unarchived', entityType: 'club_group', entityId: g.id });
        return g;
      });
      return withCount(actor, g);
    });
  }

  app.get(
    '/groups/:id/members',
    { schema: { tags, summary: 'Mitglieder einer Gruppe an einem Stichtag', params: idParam, querystring: z.object({ at: z.iso.date().optional() }), response: { 200: z.array(memberListItem) } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'members', 'read');
      await loadGroup(actor, req.params.id);
      const today = await orgToday(db, actor.organizationId);
      const at = req.query.at ?? today;
      const rows = await db
        .selectFrom('member')
        .innerJoin('person', 'person.id', 'member.person_id')
        .innerJoin('group_membership as gm', 'gm.member_id', 'member.id')
        .select(memberColumns)
        .where('gm.group_id', '=', req.params.id)
        .where('gm.valid_from', '<=', at)
        .where((eb) => eb.or([eb('gm.valid_to', 'is', null), eb('gm.valid_to', '>=', at)]))
        .where('member.organization_id', '=', actor.organizationId)
        .where(applyScope(actor, today, 'read'))
        .orderBy('person.last_name')
        .orderBy('person.first_name')
        .execute();
      const groups = await currentGroups(db, rows.map((r) => r.id), today);
      const hidden = restrictedFields(actor);
      return rows.map((r) => toListItem(r, groups.get(r.id) ?? [], hidden));
    },
  );

  const membershipDto = z.object({ id: z.uuid(), memberId: z.uuid(), groupId: z.uuid(), validFrom: z.string(), validTo: z.string().nullable() });

  app.post('/group-memberships', { schema: { tags, summary: 'Mitglied ab einem Datum in eine Gruppe aufnehmen', body: membershipCreate, response: { 201: membershipDto } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'write');
    await loadMemberRow(db, actor, req.body.memberId, 'write');
    await assertGroup(db, actor, req.body.groupId);
    if (req.body.validTo && req.body.validTo < req.body.validFrom) throw new Problem(400, 'validation', 'Das Ende liegt vor dem Beginn.', undefined, { errors: [{ field: 'validTo', message: 'Liegt vor dem Beginn.' }] });
    const m = await db.transaction().execute(async (tx) => {
      const m = await tx
        .insertInto('group_membership')
        .values({ organization_id: actor.organizationId, member_id: req.body.memberId, group_id: req.body.groupId, valid_from: req.body.validFrom, valid_to: req.body.validTo ?? null })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'member.group_added', entityType: 'member', entityId: m.member_id, diff: { groupId: [null, m.group_id], validFrom: [null, m.valid_from], validTo: [null, m.valid_to] } });
      return m;
    });
    reply.status(201);
    return { id: m.id, memberId: m.member_id, groupId: m.group_id, validFrom: m.valid_from, validTo: m.valid_to };
  });

  async function loadMembership(actor: Actor, id: string) {
    const m = await db.selectFrom('group_membership').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!m) throw notFound('Gruppenzugehörigkeit');
    await loadMemberRow(db, actor, m.member_id, 'write');
    await assertGroup(db, actor, m.group_id);
    return m;
  }

  app.patch('/group-memberships/:id', { schema: { tags, summary: 'Gruppenzugehörigkeit beenden oder Ende ändern', params: idParam, body: membershipPatch, response: { 200: membershipDto } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'write');
    const before = await loadMembership(actor, req.params.id);
    if (req.body.validTo && req.body.validTo < before.valid_from) throw new Problem(400, 'validation', 'Das Ende liegt vor dem Beginn.', undefined, { errors: [{ field: 'validTo', message: 'Liegt vor dem Beginn.' }] });
    const m = await db.transaction().execute(async (tx) => {
      const m = await tx.updateTable('group_membership').set({ valid_to: req.body.validTo }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'member.group_ended', entityType: 'member', entityId: m.member_id, diff: { groupId: [m.group_id, m.group_id], validTo: [before.valid_to, m.valid_to] } });
      return m;
    });
    return { id: m.id, memberId: m.member_id, groupId: m.group_id, validFrom: m.valid_from, validTo: m.valid_to };
  });

  app.delete('/group-memberships/:id', { schema: { tags, summary: 'Falsch erfasste Gruppenzugehörigkeit löschen (wird protokolliert)', params: idParam, body: z.object({}).optional(), response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'write');
    const m = await loadMembership(actor, req.params.id);
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('group_membership').where('id', '=', m.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'member.group_deleted', entityType: 'member', entityId: m.member_id, diff: { groupId: [m.group_id, null], validFrom: [m.valid_from, null], validTo: [m.valid_to, null] } });
    });
    reply.status(204);
    return null;
  });
};
