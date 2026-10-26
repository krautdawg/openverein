import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { notFound, Problem } from '../http/problem.ts';
import { can, requirePermission } from '../policy.ts';

const tags = ['members'];
const view = z.object({ id: z.uuid(), name: z.string(), params: z.string(), shared: z.boolean(), sharedRoleId: z.uuid().nullable(), mine: z.boolean() });

/**
 * Saved member list views. A view stores the list's URL parameters only; the server applies the viewer's own
 * permissions to every list request, so a shared view never shows more than the viewer may see.
 */
export const viewRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/member-views', { schema: { tags, summary: 'Gespeicherte Ansichten der Mitgliederliste (eigene und mit Deiner Rolle geteilte)', response: { 200: z.array(view) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    if (actor.kind !== 'user') return [];
    const roles = actor.grants.map((g) => g.roleId);
    const rows = await db.selectFrom('saved_view').selectAll().where('organization_id', '=', actor.organizationId)
      .where((eb) => eb.or([eb('owner_id', '=', actor.id), ...(roles.length ? [eb('shared_role_id', 'in', roles)] : [])]))
      .orderBy('name').execute();
    return rows.map((r) => ({ id: r.id, name: r.name, params: r.params, shared: !!r.shared_role_id, sharedRoleId: r.shared_role_id, mine: r.owner_id === actor.id }));
  });

  app.post('/member-views', { schema: { tags, summary: 'Ansicht speichern (privat oder für eine Rolle)', body: z.object({ name: z.string().trim().min(1).max(80), params: z.string().max(2000), sharedRoleId: z.uuid().nullish() }), response: { 201: view } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    if (actor.kind !== 'user') throw new Problem(400, 'users-only', 'Ansichten gehören zu Personen, nicht zu API-Schlüsseln.');
    const b = req.body;
    // Sharing with a role is an admin decision.
    if (b.sharedRoleId) {
      if (!can(actor, 'settings', 'write')) throw new Problem(403, 'forbidden', 'Ansichten teilen dürfen nur Zugänge mit Einstellungsrechten.', undefined, { permission: 'settings:write' });
      if (!(await db.selectFrom('role').select('id').where('id', '=', b.sharedRoleId).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw notFound('Rolle');
    }
    const params = new URLSearchParams(b.params).toString();
    if (params.length > 2000) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'params', message: 'Zu viele Filter für eine Ansicht.' }] });
    const r = await db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('saved_view').values({ organization_id: actor.organizationId, owner_id: actor.id, name: b.name, params, shared_role_id: b.sharedRoleId ?? null }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'member_view.saved', entityType: 'saved_view', entityId: r.id, diff: { name: [null, b.name], shared: [null, !!b.sharedRoleId] } });
      return r;
    });
    reply.status(201);
    return { id: r.id, name: r.name, params: r.params, shared: !!r.shared_role_id, sharedRoleId: r.shared_role_id, mine: true };
  });

  app.delete('/member-views/:id', { schema: { tags, summary: 'Ansicht löschen (eigene, oder geteilte mit Einstellungsrechten)', params: z.object({ id: z.uuid() }), body: z.object({}).optional() } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const v = await db.selectFrom('saved_view').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!v) throw notFound('Ansicht');
    // Someone else's private view does not exist for this user; a shared one goes only with settings rights.
    if (v.owner_id !== actor.id && !v.shared_role_id) throw notFound('Ansicht');
    if (v.owner_id !== actor.id && !can(actor, 'settings', 'write')) throw new Problem(403, 'forbidden', 'Das ist nicht Deine Ansicht.');
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('saved_view').where('id', '=', v.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'member_view.deleted', entityType: 'saved_view', entityId: v.id, diff: { name: [v.name, null] } });
    });
    return reply.status(204).send();
  });
};
