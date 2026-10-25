import { randomBytes } from 'node:crypto';
import { baseUrlFor } from '../tenant.ts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  apiToken,
  apiTokenCreate,
  auditEvent,
  auditQuery,
  effectivePermissions,
  grantInput,
  inviteResult,
  role,
  roleCreate,
  user,
  userCreate,
  userPatch,
} from '../../shared/access.ts';
import { audit } from '../audit.ts';
import { sendSystemMail } from '../mail/system.ts';
import { requireActor, sha256 } from '../auth/session.ts';
import type { Db, Level } from '../db.ts';
import { CONSTRAINT_MESSAGES, forbidden, notFound, Problem } from '../http/problem.ts';
import { maskDiff } from '../members/query.ts';
import { type Actor, level, loadGrants, MODULES, requirePermission, requireStepUp, RESTRICTABLE_FIELDS, restrictedFields, scopeOf } from '../policy.ts';

CONSTRAINT_MESSAGES.role_organization_id_name_key = 'Eine Rolle mit diesem Namen gibt es schon.';

const idParam = z.object({ id: z.uuid() });
const INVITE_DAYS = 7;

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

const normalisePermissions = (p: Record<string, Level>) => Object.fromEntries(MODULES.map((m) => [m, p[m] ?? 'none'])) as Record<string, Level>;

export const accessRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function rolesById(actor: Actor) {
    const rows = await db.selectFrom('role').selectAll().where('organization_id', '=', actor.organizationId).execute();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** No escalation: nobody hands out (or defines) more than they hold themselves, module by module and field by field. */
  function assertNotAbove(actor: Actor, permissions: Record<string, Level>, scopeGroupIds?: string[] | null, restricted?: string[]) {
    if (restricted) {
      const hidden = [...restrictedFields(actor)].filter((f) => !restricted.includes(f));
      if (hidden.length) throw forbidden(`members.field.${hidden[0]} (Feld, das Du selbst nicht siehst)`);
    }
    for (const m of MODULES) {
      const wanted = permissions[m] ?? 'none';
      if (RANK[wanted] > RANK[level(actor, m)]) throw forbidden(`${m}:${wanted} (mehr Rechte, als Du selbst hast)`);
      // A scoped actor may only grant within their own scope.
      const mine = wanted === 'none' ? null : scopeOf(actor, m, wanted);
      if (mine !== null && (!scopeGroupIds?.length || scopeGroupIds.some((g) => !mine.includes(g)))) throw forbidden(`${m}:${wanted} (außerhalb Deines Bereichs)`);
    }
  }

  async function checkGrants(actor: Actor, grants: z.infer<typeof grantInput>[]) {
    const roles = await rolesById(actor);
    for (const g of grants) {
      const role = roles.get(g.roleId);
      if (!role) throw notFound('Rolle');
      assertNotAbove(actor, role.permissions, g.scopeGroupIds, role.restricted_fields);
      if (g.scopeGroupIds?.length) {
        const n = await db.selectFrom('club_group').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', actor.organizationId).where('id', 'in', g.scopeGroupIds).executeTakeFirstOrThrow();
        if (n.n !== new Set(g.scopeGroupIds).size) throw notFound('Gruppe');
      }
    }
  }

  /** People and role definitions are managed by people: a leaked API key must not create accounts or roles. */
  function assertHuman(actor: Actor) {
    if (actor.kind === 'token') throw forbidden('settings:write (nur angemeldete Zugänge, keine API-Schlüssel)');
  }

  /** Acting on another user (role change, lock, invite) needs at least that user's current rights. */
  async function assertCanManage(actor: Actor, targetId: string) {
    for (const g of await loadGrants(db, targetId)) assertNotAbove(actor, g.permissions as Record<string, Level>, g.scope, g.restricted);
  }

  /** Serialises user and role changes per organisation, so two parallel demotions cannot remove the last admin. */
  const lockOrg = (tx: Db, organizationId: string) => tx.selectFrom('organization').select('id').where('id', '=', organizationId).forUpdate().execute();

  async function userDto(id: string) {
    const u = await db.selectFrom('app_user').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const grants = await db
      .selectFrom('role_grant')
      .innerJoin('role', 'role.id', 'role_grant.role_id')
      .select(['role_grant.id', 'role_grant.role_id', 'role.name', 'role_grant.scope_group_ids'])
      .where('role_grant.user_id', '=', id)
      .orderBy('role.name')
      .execute();
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      status: u.status,
      invited: !u.password_hash,
      lastLoginAt: u.last_login_at?.toISOString() ?? null,
      totpEnabled: !!u.totp_enabled_at,
      grants: grants.map((g) => ({ id: g.id, roleId: g.role_id, roleName: g.name, scopeGroupIds: g.scope_group_ids })),
    };
  }

  async function loadUser(actor: Actor, id: string) {
    const u = await db.selectFrom('app_user').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!u) throw notFound('Zugang');
    return u;
  }

  /** At least one active user must keep the unscoped Admin role. */
  async function assertAdminRemains(tx: Db, organizationId: string) {
    const n = await tx
      .selectFrom('role_grant')
      .innerJoin('role', 'role.id', 'role_grant.role_id')
      .innerJoin('app_user', 'app_user.id', 'role_grant.user_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('role.organization_id', '=', organizationId)
      .where('role.builtin_key', '=', 'admin')
      .where('role_grant.scope_group_ids', 'is', null)
      .where('app_user.status', '=', 'active')
      .where('app_user.password_hash', 'is not', null)
      .executeTakeFirstOrThrow();
    if (n.n === 0) throw new Problem(409, 'last-admin', 'Mindestens ein aktiver Zugang muss die Rolle Admin für den ganzen Verein behalten.');
  }

  async function newInvite(tx: Db, userId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    await tx.updateTable('app_user').set({ invite_token_hash: sha256(token), invite_expires_at: expiresAt, updated_at: new Date() }).where('id', '=', userId).execute();
    return { inviteToken: token, expiresAt: expiresAt.toISOString() };
  }

  /** Mails the invitation link; when no mail server works, the admin passes the shown link on by hand. */
  async function sendInvite(actor: Actor, email: string, name: string, token: string) {
    return sendSystemMail(db, actor.organizationId, 'invitation', email, { name, vorname: name.split(' ')[0], link: `${await baseUrlFor(db, actor.organizationId)}/einladung#${token}` });
  }

  // ---------- Roles ----------

  app.get('/roles', { schema: { tags: ['access'], summary: 'Rollen (eingebaute und eigene)', response: { 200: z.array(role) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'read');
    const rows = await db.selectFrom('role').selectAll().where('organization_id', '=', actor.organizationId).orderBy(sql`builtin_key is null`).orderBy('name').execute();
    return rows.map((r) => ({ id: r.id, name: r.name, builtin: r.builtin_key !== null, permissions: normalisePermissions(r.permissions), restrictedFields: r.restricted_fields }));
  });

  app.post('/roles', { schema: { tags: ['access'], summary: 'Eigene Rolle anlegen (z. B. als Kopie einer eingebauten)', body: roleCreate, response: { 201: role } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    requireStepUp(actor);
    assertHuman(actor);
    const fields = req.body.restrictedFields.filter((f) => (RESTRICTABLE_FIELDS as readonly string[]).includes(f));
    assertNotAbove(actor, req.body.permissions, null, fields);
    const r = await db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('role')
        .values({ organization_id: actor.organizationId, name: req.body.name, permissions: JSON.stringify(normalisePermissions(req.body.permissions)) as never, restricted_fields: fields })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'role.created', entityType: 'role', entityId: r.id, diff: { name: [null, r.name], permissions: [null, r.permissions] } });
      return r;
    });
    reply.status(201);
    return { id: r.id, name: r.name, builtin: false, permissions: normalisePermissions(r.permissions), restrictedFields: r.restricted_fields };
  });

  app.patch('/roles/:id', { schema: { tags: ['access'], summary: 'Eigene Rolle ändern (eingebaute Rollen sind unveränderlich)', params: idParam, body: roleCreate.partial(), response: { 200: role } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    requireStepUp(actor);
    const before = (await rolesById(actor)).get(req.params.id);
    if (!before) throw notFound('Rolle');
    if (before.builtin_key) throw new Problem(409, 'builtin-role', 'Eingebaute Rollen lassen sich nicht ändern. Lege eine Kopie an.');
    assertHuman(actor);
    assertNotAbove(actor, before.permissions, null, before.restricted_fields);
    if (req.body.permissions || req.body.restrictedFields) assertNotAbove(actor, req.body.permissions ?? before.permissions, null, req.body.restrictedFields ?? before.restricted_fields);
    const values: Record<string, unknown> = {};
    if (req.body.name) values.name = req.body.name;
    if (req.body.permissions) values.permissions = JSON.stringify(normalisePermissions(req.body.permissions));
    if (req.body.restrictedFields) values.restricted_fields = req.body.restrictedFields.filter((f) => (RESTRICTABLE_FIELDS as readonly string[]).includes(f));
    const r = await db.transaction().execute(async (tx) => {
      await lockOrg(tx, actor.organizationId);
      const r = await tx.updateTable('role').set(values).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'role.updated', entityType: 'role', entityId: r.id, diff: { permissions: [before.permissions, r.permissions], restrictedFields: [before.restricted_fields, r.restricted_fields] } });
      await assertAdminRemains(tx, actor.organizationId);
      return r;
    });
    return { id: r.id, name: r.name, builtin: false, permissions: normalisePermissions(r.permissions), restrictedFields: r.restricted_fields };
  });

  app.delete('/roles/:id', { schema: { tags: ['access'], summary: 'Eigene Rolle löschen, wenn sie niemandem zugewiesen ist', params: idParam, body: z.object({}).optional(), response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    requireStepUp(actor);
    assertHuman(actor);
    const r = (await rolesById(actor)).get(req.params.id);
    if (!r) throw notFound('Rolle');
    if (r.builtin_key) throw new Problem(409, 'builtin-role', 'Eingebaute Rollen lassen sich nicht löschen.');
    const used = await db.selectFrom('role_grant').select('id').where('role_id', '=', r.id).executeTakeFirst();
    const usedByToken = await db.selectFrom('api_token').select('id').where('role_id', '=', r.id).where('revoked_at', 'is', null).executeTakeFirst();
    if (used || usedByToken) throw new Problem(409, 'role-in-use', 'Die Rolle ist noch Zugängen oder API-Schlüsseln zugewiesen.');
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('role').where('id', '=', r.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'role.deleted', entityType: 'role', entityId: r.id, diff: { name: [r.name, null] } });
    });
    reply.status(204);
    return null;
  });

  // ---------- Users ----------

  app.get('/users', { schema: { tags: ['access'], summary: 'Zugänge zur Verwaltung', response: { 200: z.array(user) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'read');
    const ids = await db.selectFrom('app_user').select('id').where('organization_id', '=', actor.organizationId).orderBy('name').execute();
    return Promise.all(ids.map((u) => userDto(u.id)));
  });

  app.post('/users', { schema: { tags: ['access'], summary: 'Zugang anlegen und Einladungslink erzeugen (Link wird nur einmal angezeigt)', body: userCreate, response: { 201: inviteResult } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    requireStepUp(actor);
    assertHuman(actor);
    await checkGrants(actor, req.body.grants);
    const result = await db.transaction().execute(async (tx) => {
      const u = await tx.insertInto('app_user').values({ organization_id: actor.organizationId, email: req.body.email, name: req.body.name, password_hash: null }).returningAll().executeTakeFirstOrThrow();
      for (const g of req.body.grants) {
        await tx.insertInto('role_grant').values({ organization_id: actor.organizationId, user_id: u.id, role_id: g.roleId, scope_group_ids: g.scopeGroupIds?.length ? g.scopeGroupIds : null }).execute();
      }
      await audit(tx, actor.organizationId, actor, { action: 'user.created', entityType: 'app_user', entityId: u.id, diff: { email: [null, u.email], grants: [null, req.body.grants] } });
      return { id: u.id, invite: await newInvite(tx, u.id) };
    });
    reply.status(201);
    return { user: await userDto(result.id), ...result.invite, mailed: await sendInvite(actor, req.body.email, req.body.name, result.invite.inviteToken) };
  });

  app.post('/users/:id/invite', { schema: { tags: ['access'], summary: 'Neuen Einladungslink erzeugen (der alte wird ungültig)', params: idParam, body: z.object({}).optional(), response: { 200: inviteResult } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    requireStepUp(actor);
    assertHuman(actor);
    const u = await loadUser(actor, req.params.id);
    // An invitation is not a password reset: once the user has set a password, no new link.
    if (u.password_hash) throw new Problem(409, 'already-active', 'Der Zugang ist schon eingerichtet.');
    await assertCanManage(actor, u.id);
    const invite = await db.transaction().execute(async (tx) => {
      const invite = await newInvite(tx, u.id);
      await audit(tx, actor.organizationId, actor, { action: 'user.invited', entityType: 'app_user', entityId: u.id });
      return invite;
    });
    return { user: await userDto(u.id), ...invite, mailed: await sendInvite(actor, u.email, u.name, invite.inviteToken) };
  });

  app.post('/users/:id/totp/reset', { schema: { tags: ['access'], summary: 'Zweiten Faktor eines Zugangs zurücksetzen (Handy verloren); die Person richtet ihn neu ein', params: idParam, body: z.object({}).optional(), response: { 200: user } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    requireStepUp(actor);
    assertHuman(actor);
    const u = await loadUser(actor, req.params.id);
    await assertCanManage(actor, u.id);
    if (u.id === actor.userId) throw new Problem(409, 'self-reset', 'Deinen eigenen zweiten Faktor richtest Du unter Sicherheit neu ein.');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('app_user').set({ totp_secret_encrypted: null, totp_enabled_at: null, totp_last_step: null, updated_at: new Date() }).where('id', '=', u.id).execute();
      await tx.deleteFrom('totp_recovery_code').where('user_id', '=', u.id).execute();
      // Sessions confirmed with the old factor end too.
      await tx.deleteFrom('session').where('user_id', '=', u.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'auth.totp_reset', entityType: 'app_user', entityId: u.id });
    });
    return userDto(u.id);
  });

  app.patch('/users/:id', { schema: { tags: ['access'], summary: 'Zugang ändern: Name, sperren/entsperren, Rollen', params: idParam, body: userPatch, response: { 200: user } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    requireStepUp(actor);
    assertHuman(actor);
    const u = await loadUser(actor, req.params.id);
    await assertCanManage(actor, u.id);
    if (req.body.status === 'disabled' && u.id === actor.userId) throw new Problem(409, 'self-disable', 'Du kannst Deinen eigenen Zugang nicht sperren.');
    if (req.body.grants) await checkGrants(actor, req.body.grants);
    await db.transaction().execute(async (tx) => {
      await lockOrg(tx, actor.organizationId);
      const before = await userDto(u.id);
      if (req.body.name || req.body.status) {
        await tx.updateTable('app_user').set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.status ? { status: req.body.status } : {}), updated_at: new Date() }).where('id', '=', u.id).execute();
      }
      if (req.body.status === 'disabled') await tx.deleteFrom('session').where('user_id', '=', u.id).execute();
      if (req.body.grants) {
        await tx.deleteFrom('role_grant').where('user_id', '=', u.id).execute();
        for (const g of req.body.grants) {
          await tx.insertInto('role_grant').values({ organization_id: actor.organizationId, user_id: u.id, role_id: g.roleId, scope_group_ids: g.scopeGroupIds?.length ? g.scopeGroupIds : null }).execute();
        }
      }
      await audit(tx, actor.organizationId, actor, { action: 'user.updated', entityType: 'app_user', entityId: u.id, diff: { name: [before.name, req.body.name ?? before.name], status: [before.status, req.body.status ?? before.status], grants: [before.grants, req.body.grants ?? before.grants] } });
      await assertAdminRemains(tx, actor.organizationId);
    });
    return userDto(u.id);
  });

  app.get('/users/:id/permissions', { schema: { tags: ['access'], summary: 'Effektive Rechte eines Zugangs prüfen', params: idParam, response: { 200: effectivePermissions } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'read');
    const u = await loadUser(actor, req.params.id);
    const subject: Actor = { kind: 'user', id: u.id, userId: u.id, name: u.name, organizationId: u.organization_id, grants: await loadGrants(db, u.id) };
    const groups = new Map((await db.selectFrom('club_group').select(['id', 'name']).where('organization_id', '=', actor.organizationId).execute()).map((g) => [g.id, g.name]));
    return {
      modules: MODULES.map((m) => {
        const l = level(subject, m);
        const scope = l === 'none' ? null : scopeOf(subject, m, l);
        return { module: m, level: l, scope: scope && scope.map((id) => groups.get(id) ?? id) };
      }),
      restrictedFields: [...restrictedFields(subject)],
    };
  });

  // ---------- API tokens ----------

  const tokenDto = async (actor: Actor) => {
    const rows = await db
      .selectFrom('api_token')
      .innerJoin('role', 'role.id', 'api_token.role_id')
      .select(['api_token.id', 'api_token.name', 'api_token.prefix', 'api_token.role_id', 'role.name as role_name', 'api_token.scope_group_ids', 'api_token.expires_at', 'api_token.last_used_at', 'api_token.revoked_at'])
      .where('api_token.organization_id', '=', actor.organizationId)
      .orderBy('api_token.created_at', 'desc')
      .execute();
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      roleId: t.role_id,
      roleName: t.role_name,
      scopeGroupIds: t.scope_group_ids,
      expiresAt: t.expires_at.toISOString(),
      lastUsedAt: t.last_used_at?.toISOString() ?? null,
      revoked: t.revoked_at !== null,
    }));
  };

  app.get('/api-tokens', { schema: { tags: ['access'], summary: 'API-Schlüssel', response: { 200: z.array(apiToken) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'api', 'read');
    return tokenDto(actor);
  });

  app.post(
    '/api-tokens',
    { schema: { tags: ['access'], summary: 'API-Schlüssel mit einer Rolle erstellen (wird nur einmal angezeigt)', body: apiTokenCreate, response: { 201: z.object({ token: z.string(), apiToken }) } } },
    async (req, reply) => {
      const actor = requireActor(req);
      requirePermission(actor, 'api', 'write');
      requireStepUp(actor);
      requirePermission(actor, 'settings', 'write');
      // Tokens cannot create tokens: a leaked key must not be able to mint more keys.
      if (actor.kind === 'token') throw forbidden('api:write (nur angemeldete Zugänge)');
      await checkGrants(actor, [{ roleId: req.body.roleId, scopeGroupIds: req.body.scopeGroupIds }]);
      const prefix = randomBytes(4).toString('hex');
      const token = `ov_${prefix}_${randomBytes(32).toString('base64url')}`;
      const id = await db.transaction().execute(async (tx) => {
        const t = await tx
          .insertInto('api_token')
          .values({
            organization_id: actor.organizationId,
            name: req.body.name,
            prefix,
            token_hash: sha256(token),
            role_id: req.body.roleId,
            scope_group_ids: req.body.scopeGroupIds?.length ? req.body.scopeGroupIds : null,
            created_by: actor.userId,
            expires_at: new Date(Date.now() + req.body.expiresInDays * 86_400_000),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await audit(tx, actor.organizationId, actor, { action: 'api_token.created', entityType: 'api_token', entityId: t.id, diff: { name: [null, req.body.name], roleId: [null, req.body.roleId] } });
        return t.id;
      });
      reply.status(201);
      return { token, apiToken: (await tokenDto(actor)).find((t) => t.id === id)! };
    },
  );

  app.post('/api-tokens/:id/revoke', { schema: { tags: ['access'], summary: 'API-Schlüssel widerrufen', params: idParam, body: z.object({}).optional(), response: { 200: apiToken } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'api', 'write');
    const res = await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('api_token').set({ revoked_at: new Date() }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where('revoked_at', 'is', null).executeTakeFirst();
      if (Number(r.numUpdatedRows) > 0) await audit(tx, actor.organizationId, actor, { action: 'api_token.revoked', entityType: 'api_token', entityId: req.params.id });
      return r;
    });
    const t = (await tokenDto(actor)).find((x) => x.id === req.params.id);
    if (!t || (Number(res.numUpdatedRows) === 0 && !t.revoked)) throw notFound('API-Schlüssel');
    return t;
  });

  // ---------- Audit log ----------

  app.get('/audit-events', { schema: { tags: ['access'], summary: 'Änderungsprotokoll (neueste zuerst)', querystring: auditQuery, response: { 200: z.object({ items: z.array(auditEvent), nextCursor: z.number().nullable() }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'audit', 'read');
    // The log covers the whole club, so a grant limited to some groups cannot read it.
    if (scopeOf(actor, 'audit', 'read') !== null) throw forbidden('audit:read (für den ganzen Verein)');
    let q = db.selectFrom('audit_event').selectAll().where('organization_id', '=', actor.organizationId);
    if (req.query.entityType) q = q.where('entity_type', '=', req.query.entityType);
    if (req.query.entityId) q = q.where('entity_id', '=', req.query.entityId);
    if (req.query.action) q = q.where('action', 'like', `${req.query.action.replace(/[%_]/g, '')}%`);
    if (req.query.cursor) q = q.where('id', '<', req.query.cursor);
    const rows = await q.orderBy('id', 'desc').limit(req.query.limit).execute();
    const hidden = restrictedFields(actor);
    return {
      items: rows.map((r) => ({ id: r.id, at: r.at.toISOString(), actor: r.actor_label, action: r.action, entityType: r.entity_type, entityId: r.entity_id, diff: maskDiff(r.diff, hidden) })),
      nextCursor: rows.length === req.query.limit ? rows[rows.length - 1]!.id : null,
    };
  });

  // ---------- Overview ----------

  app.get(
    '/overview',
    {
      schema: {
        tags: ['system'],
        summary: 'Kennzahlen für die Startseite (nur mit Leserecht auf Mitglieder)',
        response: { 200: z.object({ members: z.object({ active: z.number(), future: z.number(), applicants: z.number(), resigned: z.number(), joinedThisYear: z.number(), leftThisYear: z.number() }).nullable(), groups: z.number().nullable(), onlineApplications: z.number().nullable(), setup: z.object({ clubDetails: z.boolean(), users: z.number() }) }) },
      },
    },
    async (req) => {
      const actor = requireActor(req);
      // First-run checklist: derived from data, never a fixed tick.
      const o = await db.selectFrom('organization').select(['street', 'postal_code', 'city', 'email']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
      const users = await db.selectFrom('app_user').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', actor.organizationId).where('status', '=', 'active').executeTakeFirstOrThrow();
      const setup = { clubDetails: !!(o.street && o.postal_code && o.city && o.email), users: users.n };
      if (level(actor, 'members') === 'none') return { members: null, groups: null, onlineApplications: null, setup };
      const org = await db.selectFrom('organization').select('time_zone').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.time_zone }).format(new Date());
      const yearStart = `${today.slice(0, 4)}-01-01`;
      const scope = scopeOf(actor, 'members', 'read');
      const scoped = scope === null ? sql`true` : sql`exists (select 1 from group_membership gm where gm.member_id = member.id and gm.group_id = any(${scope}::uuid[]) and gm.valid_from <= ${today}::date and (gm.valid_to is null or gm.valid_to >= ${today}::date - interval '12 months'))`;
      const m = await sql<{ active: number; future: number; applicants: number; resigned: number; joined: number; left: number }>`
        select
          count(*) filter (where status = 'active')::int as active,
          count(*) filter (where status = 'future')::int as future,
          count(*) filter (where status = 'applicant')::int as applicants,
          count(*) filter (where status = 'resigned')::int as resigned,
          count(*) filter (where join_date between ${yearStart}::date and ${today}::date)::int as joined,
          count(*) filter (where exit_date between ${yearStart}::date and ${today}::date)::int as left
        from member where organization_id = ${actor.organizationId} and ${scoped}`.execute(db);
      const g = await db.selectFrom('club_group').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', actor.organizationId).where('archived_at', 'is', null).executeTakeFirstOrThrow();
      const r = m.rows[0]!;
      const apps = scope === null ? (await db.selectFrom('application').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', actor.organizationId).where('status', '=', 'new').executeTakeFirstOrThrow()).n : null;
      return { members: { active: r.active, future: r.future, applicants: r.applicants, resigned: r.resigned, joinedThisYear: r.joined, leftThisYear: r.left }, groups: g.n, onlineApplications: apps, setup };
    },
  );
};
