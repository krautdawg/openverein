import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { baseUrlOf } from '../tenant.ts';
import { z } from 'zod';
import { formatDate } from '../../shared/dates.ts';
import { displayName } from '../../shared/members.ts';
import { task, taskInput, taskPatch } from '../../shared/tasks.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { mailer, senderOf } from '../mail/transport.ts';
import { loadMemberRow, orgToday } from '../members/query.ts';
import { level, type Actor } from '../policy.ts';

const tags = ['tasks'];
const idParam = z.object({ id: z.uuid() });

/**
 * Tasks (spec P25): every user of the club sees and creates them; editing is for the creator, the assignee and
 * administrators. A linked member is only named to those who may read that member.
 */
export const taskRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  const isAdmin = (actor: Actor) => level(actor, 'settings') === 'write';
  const personal = (actor: Actor) => {
    if (!actor.userId) throw new Problem(400, 'personal-account', 'Aufgaben gibt es nur mit einem persönlichen Zugang.');
    return actor.userId;
  };

  async function memberName(actor: Actor, memberId: string) {
    try {
      const { row } = await loadMemberRow(db, actor, memberId, 'read');
      return displayName({ kind: row.kind, firstName: row.first_name, lastName: row.last_name, companyName: row.company_name });
    } catch {
      return null;
    }
  }

  async function list(actor: Actor, opts: { id?: string; filter?: 'open' | 'mine' | 'done' }) {
    const today = await orgToday(db, actor.organizationId);
    let q = db.selectFrom('task').leftJoin('app_user as a', 'a.id', 'task.assignee_user_id').innerJoin('app_user as c', 'c.id', 'task.created_by')
      .selectAll('task').select(['a.name as assignee_name', 'c.name as creator_name']).where('task.organization_id', '=', actor.organizationId);
    if (opts.id) q = q.where('task.id', '=', opts.id);
    else if (opts.filter === 'done') q = q.where('task.done_at', 'is not', null);
    else {
      q = q.where('task.done_at', 'is', null);
      if (opts.filter === 'mine') q = q.where('task.assignee_user_id', '=', actor.userId ?? '00000000-0000-0000-0000-000000000000');
    }
    const rows = await (opts.filter === 'done' ? q.orderBy('task.done_at', 'desc').limit(200) : q.orderBy('task.due_on', 'asc').orderBy('task.created_at', 'asc').limit(500)).execute();
    return Promise.all(rows.map(async (t) => {
      const name = t.member_id ? await memberName(actor, t.member_id) : null;
      return {
        id: t.id, title: t.title, note: t.note, dueOn: t.due_on, overdue: !t.done_at && !!t.due_on && t.due_on < today,
        assignee: t.assignee_user_id ? { id: t.assignee_user_id, name: t.assignee_name ?? '' } : null,
        member: t.member_id && name ? { id: t.member_id, name } : null,
        done: !!t.done_at, doneAt: t.done_at?.toISOString() ?? null, createdBy: t.creator_name,
        canEdit: t.created_by === actor.userId || t.assignee_user_id === actor.userId || isAdmin(actor),
        canDelete: t.created_by === actor.userId || isAdmin(actor),
      };
    }));
  }

  async function assigneeOf(conn: Db, actor: Actor, id: string) {
    const u = await conn.selectFrom('app_user').select(['id', 'name', 'email']).where('id', '=', id).where('organization_id', '=', actor.organizationId).where('status', '=', 'active').executeTakeFirst();
    if (!u) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'assigneeUserId', message: 'Diesen Zugang gibt es nicht (mehr).' }] });
    return u;
  }

  /** Tells the assignee by mail; a failing relay does not block the task. */
  async function notify(actor: Actor, to: { name: string; email: string }, title: string, dueOn: string | null | undefined) {
    const org = await db.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const sender = senderOf(org);
    await mailer().sendMail({ from: { name: sender.name, address: sender.address }, to: to.email, subject: `Neue Aufgabe: ${title}`, text: `Hallo ${to.name},\n\n${actor.name} hat Dir eine Aufgabe gegeben: ${title}${dueOn ? ` (bis ${formatDate(dueOn)})` : ''}.\n\n${baseUrlOf(org)}/aufgaben\n\n${org.name}` }).catch(() => undefined);
  }

  app.get('/tasks', { schema: { tags, summary: 'Aufgaben: offen (Standard), meine oder erledigt', querystring: z.object({ filter: z.enum(['open', 'mine', 'done']).default('open') }), response: { 200: z.array(task) } } }, async (req) => {
    const actor = requireActor(req);
    // Tasks are between people of the club: an API key (scoped to some module or group) sees none.
    personal(actor);
    return list(actor, { filter: req.query.filter });
  });

  app.get('/tasks/assignees', { schema: { tags, summary: 'Wem eine Aufgabe gegeben werden kann (aktive Zugänge)', response: { 200: z.array(z.object({ id: z.uuid(), name: z.string() })) } } }, async (req) => {
    const actor = requireActor(req);
    personal(actor);
    return db.selectFrom('app_user').select(['id', 'name']).where('organization_id', '=', actor.organizationId).where('status', '=', 'active').orderBy('name').execute();
  });

  app.post('/tasks', { schema: { tags, summary: 'Aufgabe anlegen (die zugewiesene Person bekommt eine E-Mail)', body: taskInput, response: { 201: task } } }, async (req, reply) => {
    const actor = requireActor(req);
    const userId = personal(actor);
    const b = req.body;
    if (b.memberId) await loadMemberRow(db, actor, b.memberId, 'read');
    const assignee = b.assigneeUserId ? await assigneeOf(db, actor, b.assigneeUserId) : null;
    const id = await db.transaction().execute(async (tx) => {
      const t = await tx.insertInto('task').values({ organization_id: actor.organizationId, title: b.title, note: b.note ?? null, due_on: b.dueOn ?? null, assignee_user_id: assignee?.id ?? null, member_id: b.memberId ?? null, created_by: userId }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'task.created', entityType: 'task', entityId: t.id, diff: { title: [null, b.title] } });
      return t.id;
    });
    if (assignee && assignee.id !== userId) await notify(actor, assignee, b.title, b.dueOn);
    reply.status(201);
    return (await list(actor, { id }))[0]!;
  });

  /** Locked and checked in the caller's transaction: a reassignment meanwhile is seen before the change. */
  async function editable(tx: Db, actor: Actor, id: string) {
    const t = await tx.selectFrom('task').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
    if (!t) throw notFound('Aufgabe');
    if (t.created_by !== actor.userId && t.assignee_user_id !== actor.userId && !isAdmin(actor)) throw new Problem(403, 'forbidden', 'Diese Aufgabe ändern nur die Person, die sie angelegt hat, die zuständige Person oder die Verwaltung.');
    return t;
  }

  app.patch('/tasks/:id', { schema: { tags, summary: 'Aufgabe ändern, zuweisen oder erledigen', params: idParam, body: taskPatch, response: { 200: task } } }, async (req) => {
    const actor = requireActor(req);
    const userId = personal(actor);
    const b = req.body;
    const assignee = b.assigneeUserId ? await assigneeOf(db, actor, b.assigneeUserId) : null;
    const t = await db.transaction().execute(async (tx) => {
      const t = await editable(tx, actor, req.params.id);
      await tx.updateTable('task').set({
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.note !== undefined ? { note: b.note } : {}),
        ...(b.dueOn !== undefined ? { due_on: b.dueOn } : {}),
        ...(b.assigneeUserId !== undefined ? { assignee_user_id: b.assigneeUserId } : {}),
        ...(b.done !== undefined ? { done_at: b.done ? new Date() : null, done_by: b.done ? userId : null } : {}),
      }).where('id', '=', t.id).execute();
      await audit(tx, actor.organizationId, actor, { action: b.done === true ? 'task.done' : b.done === false ? 'task.reopened' : 'task.updated', entityType: 'task', entityId: t.id });
      return t;
    });
    if (assignee && assignee.id !== t.assignee_user_id && assignee.id !== userId) await notify(actor, assignee, b.title ?? t.title, b.dueOn ?? t.due_on);
    return (await list(actor, { id: t.id }))[0]!;
  });

  app.delete('/tasks/:id', { schema: { tags, summary: 'Aufgabe löschen (Person, die sie angelegt hat, oder Verwaltung)', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    await db.transaction().execute(async (tx) => {
      const t = await editable(tx, actor, req.params.id);
      if (t.created_by !== actor.userId && !isAdmin(actor)) throw new Problem(403, 'forbidden', 'Löschen kann nur die Person, die die Aufgabe angelegt hat.');
      await tx.deleteFrom('task').where('id', '=', t.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'task.deleted', entityType: 'task', entityId: t.id, diff: { title: [t.title, null] } });
    });
    return reply.status(204).send();
  });
};
