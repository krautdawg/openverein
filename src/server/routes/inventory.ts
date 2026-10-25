import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { displayName } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { notFound, Problem } from '../http/problem.ts';
import { loadMemberRow, orgToday } from '../members/query.ts';
import { requireClubWide, requirePermission, type Actor } from '../policy.ts';

const tags = ['documents'];
const idParam = z.object({ id: z.uuid() });
const itemInput = z.object({
  name: z.string().trim().min(1, 'Pflichtfeld.').max(200),
  category: z.string().trim().max(80).nullish(),
  location: z.string().trim().max(200).nullish(),
  serial: z.string().trim().max(100).nullish(),
  quantity: z.number().int().min(1).max(100_000).default(1),
  valueCents: z.number().int().min(0).nullish(),
  note: z.string().trim().max(2000).nullish(),
});
const loan = z.object({ id: z.uuid(), memberId: z.uuid(), memberName: z.string(), quantity: z.number(), lentOn: z.string(), dueOn: z.string().nullable(), overdue: z.boolean() });
const item = itemInput.extend({ id: z.uuid(), category: z.string().nullable(), location: z.string().nullable(), serial: z.string().nullable(), valueCents: z.number().nullable(), note: z.string().nullable(), archived: z.boolean(), available: z.number(), loans: z.array(loan) });

export const inventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function list(actor: Actor, id?: string) {
    const today = await orgToday(db, actor.organizationId);
    let q = db.selectFrom('inventory_item').selectAll().where('organization_id', '=', actor.organizationId);
    q = id ? q.where('id', '=', id) : q.where('archived_at', 'is', null);
    const items = await q.orderBy('category').orderBy('name').execute();
    const loans = items.length ? await db.selectFrom('inventory_loan').innerJoin('member', 'member.id', 'inventory_loan.member_id').innerJoin('person', 'person.id', 'member.person_id')
      .select(['inventory_loan.id', 'inventory_loan.item_id', 'inventory_loan.member_id', 'inventory_loan.quantity', 'inventory_loan.lent_on', 'inventory_loan.due_on', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('inventory_loan.item_id', 'in', items.map((i) => i.id)).where('inventory_loan.returned_on', 'is', null).orderBy('inventory_loan.lent_on').execute() : [];
    return items.map((i) => {
      const open = loans.filter((l) => l.item_id === i.id).map((l) => ({ id: l.id, memberId: l.member_id, memberName: displayName({ kind: l.kind, firstName: l.first_name, lastName: l.last_name, companyName: l.company_name }), quantity: l.quantity, lentOn: l.lent_on, dueOn: l.due_on, overdue: !!l.due_on && l.due_on < today }));
      return { id: i.id, name: i.name, category: i.category, location: i.location, serial: i.serial, quantity: i.quantity, valueCents: i.value_cents === null ? null : Number(i.value_cents), note: i.note, archived: i.archived_at !== null, available: i.quantity - open.reduce((s, l) => s + l.quantity, 0), loans: open };
    });
  }

  app.get('/inventory', { schema: { tags, summary: 'Inventar mit offenen Ausleihen', response: { 200: z.array(item) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'documents', 'read');
    return list(actor);
  });

  app.post('/inventory', { schema: { tags, summary: 'Gegenstand ins Inventar aufnehmen', body: itemInput, response: { 201: item } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'documents', 'write');
    const b = req.body;
    const id = await db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('inventory_item').values({ organization_id: actor.organizationId, name: b.name, category: b.category || null, location: b.location || null, serial: b.serial || null, quantity: b.quantity, value_cents: b.valueCents ?? null, note: b.note || null }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'inventory.created', entityType: 'inventory_item', entityId: r.id, diff: { name: [null, b.name] } });
      return r.id;
    });
    reply.status(201);
    return (await list(actor, id))[0]!;
  });

  app.put('/inventory/:id', { schema: { tags, summary: 'Gegenstand ändern oder ausmustern', params: idParam, body: itemInput.extend({ archived: z.boolean().default(false) }), response: { 200: item } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'documents', 'write');
    const b = req.body;
    await db.transaction().execute(async (tx) => {
      const open = await tx.selectFrom('inventory_loan').select(sql<number>`coalesce(sum(quantity), 0)::int`.as('n')).where('item_id', '=', req.params.id).where('returned_on', 'is', null).executeTakeFirstOrThrow();
      if (b.archived && open.n > 0) throw new Problem(409, 'lent', 'Der Gegenstand ist noch ausgeliehen.', 'Erst zurücknehmen, dann ausmustern.');
      if (b.quantity < open.n) throw new Problem(409, 'lent', `Es sind noch ${open.n} Stück ausgeliehen.`);
      const r = await tx.updateTable('inventory_item').set({ name: b.name, category: b.category || null, location: b.location || null, serial: b.serial || null, quantity: b.quantity, value_cents: b.valueCents ?? null, note: b.note || null, archived_at: b.archived ? sql<Date>`coalesce(archived_at, now())` : null }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('Gegenstand');
      await audit(tx, actor.organizationId, actor, { action: 'inventory.updated', entityType: 'inventory_item', entityId: req.params.id, diff: { archived: [null, b.archived], quantity: [null, b.quantity] } });
    });
    return (await list(actor, req.params.id))[0]!;
  });

  app.post('/inventory/:id/loans', { schema: { tags, summary: 'Ausleihen an ein Mitglied', params: idParam, body: z.object({ memberId: z.uuid(), quantity: z.number().int().min(1).default(1), lentOn: z.iso.date(), dueOn: z.iso.date().nullish(), note: z.string().trim().max(500).nullish() }), response: { 201: item } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'documents', 'write');
    await loadMemberRow(db, actor, req.body.memberId, 'read');
    const b = req.body;
    if (b.dueOn && b.dueOn < b.lentOn) throw new Problem(400, 'validation', 'Die Rückgabe liegt vor der Ausleihe.');
    await db.transaction().execute(async (tx) => {
      // Lock the item so two loans at the same time cannot lend more than there is.
      const i = await tx.selectFrom('inventory_item').select(['quantity', 'archived_at']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!i || i.archived_at) throw notFound('Gegenstand');
      const open = await tx.selectFrom('inventory_loan').select(sql<number>`coalesce(sum(quantity), 0)::int`.as('n')).where('item_id', '=', req.params.id).where('returned_on', 'is', null).executeTakeFirstOrThrow();
      if (open.n + b.quantity > i.quantity) throw new Problem(409, 'unavailable', `Nur noch ${i.quantity - open.n} Stück verfügbar.`);
      const l = await tx.insertInto('inventory_loan').values({ organization_id: actor.organizationId, item_id: req.params.id, member_id: b.memberId, quantity: b.quantity, lent_on: b.lentOn, due_on: b.dueOn ?? null, note: b.note || null, lent_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'inventory.lent', entityType: 'inventory_item', entityId: req.params.id, diff: { member: [null, b.memberId], quantity: [null, b.quantity], loan: [null, l.id] } });
    });
    reply.status(201);
    return (await list(actor, req.params.id))[0]!;
  });

  app.post('/inventory/loans/:id/return', { schema: { tags, summary: 'Rückgabe festhalten', params: idParam, body: z.object({ returnedOn: z.iso.date() }), response: { 200: item } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'documents', 'write');
    const l = await db.selectFrom('inventory_loan').select(['item_id', 'lent_on', 'returned_on', 'member_id']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!l) throw notFound('Ausleihe');
    if (l.returned_on) throw new Problem(409, 'returned', 'Schon zurückgegeben.');
    if (req.body.returnedOn < l.lent_on) throw new Problem(400, 'validation', 'Die Rückgabe liegt vor der Ausleihe.');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('inventory_loan').set({ returned_on: req.body.returnedOn }).where('id', '=', req.params.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'inventory.returned', entityType: 'inventory_item', entityId: l.item_id, diff: { loan: [null, req.params.id] } });
    });
    return (await list(actor, l.item_id))[0]!;
  });
};
