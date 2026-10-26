import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { household, householdInput, householdRuleInput } from '../../shared/households.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { ruleLabel } from '../fees/household.ts';
import { notFound, Problem } from '../http/problem.ts';
import { orgToday } from '../members/query.ts';
import { lockFees } from '../fees/lock.ts';
import { requireClubWide, restrictedFields, type Actor } from '../policy.ts';

const tags = ['members'];
const idParam = z.object({ id: z.uuid() });
const nameOf = (p: { kind: string; first_name: string | null; last_name: string | null; company_name: string | null }) => (p.kind === 'organisation' ? (p.company_name ?? '') : [p.first_name, p.last_name].filter(Boolean).join(' '));

export const householdRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function dto(actor: Actor, ids?: string[]) {
    const today = await orgToday(db, actor.organizationId);
    const hideBirth = restrictedFields(actor).has('birth_date');
    let q = db.selectFrom('household').innerJoin('person', 'person.id', 'household.payer_person_id').select(['household.id', 'household.name', 'household.payer_person_id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name']).where('household.organization_id', '=', actor.organizationId);
    if (ids) q = q.where('household.id', 'in', ids);
    const rows = await q.orderBy('household.name').execute();
    if (!rows.length) return [];
    const members = await db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select(['member.id', 'member.household_id', 'member.membership_number', 'member.status', 'person.id as person_id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.birth_date']).where('member.household_id', 'in', rows.map((r) => r.id)).orderBy('member.membership_number').execute();
    const rules = await db.selectFrom('household_rule').selectAll().where('household_id', 'in', rows.map((r) => r.id)).orderBy('valid_from').execute();
    return rows.map((h) => {
      const own = rules.filter((r) => r.household_id === h.id).map((r) => ({ id: r.id, validFrom: r.valid_from, kind: r.kind, fromNth: r.from_nth, percentBp: r.percent_bp, capCents: r.cap_cents === null ? null : Number(r.cap_cents), label: ruleLabel({ kind: r.kind, fromNth: r.from_nth, percentBp: r.percent_bp, capCents: r.cap_cents === null ? null : Number(r.cap_cents) }) }));
      const current = [...own].reverse().find((r) => r.validFrom <= today) ?? null;
      return {
        id: h.id,
        name: h.name,
        payerPersonId: h.payer_person_id,
        payerName: nameOf(h),
        members: members.filter((m) => m.household_id === h.id).map((m) => ({ memberId: m.id, personId: m.person_id, name: nameOf(m), membershipNumber: m.membership_number, status: m.status, birthDate: hideBirth ? null : m.birth_date })),
        rules: own,
        currentRule: current?.label ?? 'Kein Familienrabatt',
      };
    });
  }

  /** Members must belong to the club and not to another household. */
  async function assertMembers(tx: Db, actor: Actor, memberIds: string[], householdId: string | null) {
    if (!memberIds.length) return;
    const rows = await tx.selectFrom('member').select(['id', 'household_id', 'membership_number']).where('organization_id', '=', actor.organizationId).where('id', 'in', memberIds).forUpdate().execute();
    if (rows.length !== new Set(memberIds).size) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'memberIds', message: 'Mitglied nicht gefunden.' }] });
    const elsewhere = rows.filter((r) => r.household_id && r.household_id !== householdId);
    if (elsewhere.length) throw new Problem(409, 'other-household', `Schon in einem anderen Haushalt: Nr. ${elsewhere.map((r) => r.membership_number).join(', ')}.`, 'Nimm die Mitglieder dort zuerst heraus.');
  }

  app.get('/households', { schema: { tags, summary: 'Haushalte mit zahlender Person, Mitgliedern und Familienrabatt', response: { 200: z.array(household) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    return dto(actor);
  });

  app.post('/households', { schema: { tags, summary: 'Haushalt anlegen (bestimmt, wer die Beiträge zahlt: braucht auch Beitragsrechte)', body: householdInput, response: { 201: household } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    requireClubWide(actor, 'fees', 'write');
    const b = req.body;
    const id = await db.transaction().execute(async (tx) => {
      // Household changes alter fee inputs: never while a fee run is being posted.
      await lockFees(tx, actor.organizationId);
      if (!(await tx.selectFrom('person').select('id').where('id', '=', b.payerPersonId).where('organization_id', '=', actor.organizationId).where('anonymised_at', 'is', null).executeTakeFirst())) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'payerPersonId', message: 'Zahlende Person nicht gefunden.' }] });
      await assertMembers(tx, actor, b.memberIds, null);
      const h = await tx.insertInto('household').values({ organization_id: actor.organizationId, name: b.name, payer_person_id: b.payerPersonId }).returning('id').executeTakeFirstOrThrow();
      if (b.memberIds.length) await tx.updateTable('member').set({ household_id: h.id, updated_at: new Date() }).where('id', 'in', b.memberIds).execute();
      await audit(tx, actor.organizationId, actor, { action: 'household.created', entityType: 'household', entityId: h.id, diff: { name: [null, b.name], members: [null, b.memberIds.length] } });
      return h.id;
    });
    reply.status(201);
    return (await dto(actor, [id]))[0]!;
  });

  app.patch('/households/:id', { schema: { tags, summary: 'Haushalt ändern: Name, zahlende Person, Mitglieder (die zahlende Person geht nur mit Nachfolge)', params: idParam, body: householdInput.partial(), response: { 200: household } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    const b = req.body;
    // Payer and members decide who is billed and who gets the discount.
    if (b.payerPersonId || b.memberIds) requireClubWide(actor, 'fees', 'write');
    await db.transaction().execute(async (tx) => {
      // Household changes alter fee inputs: never while a fee run is being posted.
      await lockFees(tx, actor.organizationId);
      const h = await tx.selectFrom('household').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!h) throw notFound('Haushalt');
      const payer = b.payerPersonId ?? h.payer_person_id;
      if (b.payerPersonId && !(await tx.selectFrom('person').select('id').where('id', '=', b.payerPersonId).where('organization_id', '=', actor.organizationId).where('anonymised_at', 'is', null).executeTakeFirst())) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'payerPersonId', message: 'Zahlende Person nicht gefunden.' }] });
      const current = await tx.selectFrom('member').select(['id', 'person_id']).where('household_id', '=', h.id).execute();
      if (b.memberIds) {
        await assertMembers(tx, actor, b.memberIds, h.id);
        const removed = current.filter((m) => !b.memberIds!.includes(m.id));
        // The payer's own membership leaves only together with a new payer.
        if (removed.some((m) => m.person_id === payer)) throw new Problem(409, 'payer-removed', 'Die zahlende Person verlässt den Haushalt.', 'Wähle zuerst eine andere zahlende Person.');
        if (removed.length) await tx.updateTable('member').set({ household_id: null, updated_at: new Date() }).where('id', 'in', removed.map((m) => m.id)).execute();
        if (b.memberIds.length) await tx.updateTable('member').set({ household_id: h.id, updated_at: new Date() }).where('id', 'in', b.memberIds).execute();
      }
      await tx.updateTable('household').set({ ...(b.name ? { name: b.name } : {}), payer_person_id: payer, updated_at: new Date() }).where('id', '=', h.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'household.updated', entityType: 'household', entityId: h.id, diff: { name: [h.name, b.name ?? h.name], payer: [h.payer_person_id, payer], members: [current.map((m) => m.id), b.memberIds ?? current.map((m) => m.id)] } });
    });
    return (await dto(actor, [req.params.id]))[0]!;
  });

  app.post('/households/:id/rules', { schema: { tags, summary: 'Familienrabatt ab einem Datum festlegen (gilt bis zur nächsten Regel)', params: idParam, body: householdRuleInput, response: { 200: household } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    requireClubWide(actor, 'fees', 'write');
    const b = req.body;
    await db.transaction().execute(async (tx) => {
      // Household changes alter fee inputs: never while a fee run is being posted.
      await lockFees(tx, actor.organizationId);
      const h = await tx.selectFrom('household').select('id').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!h) throw notFound('Haushalt');
      const prior = await tx.selectFrom('household_rule').selectAll().where('household_id', '=', h.id).where('valid_from', '=', b.validFrom).executeTakeFirst();
      await tx
        .insertInto('household_rule')
        .values({ household_id: h.id, valid_from: b.validFrom, kind: b.kind, from_nth: b.fromNth ?? null, percent_bp: b.percentBp ?? null, cap_cents: b.capCents ?? null })
        .onConflict((oc) => oc.columns(['household_id', 'valid_from']).doUpdateSet({ kind: b.kind, from_nth: b.fromNth ?? null, percent_bp: b.percentBp ?? null, cap_cents: b.capCents ?? null }))
        .execute();
      await audit(tx, actor.organizationId, actor, { action: 'household.rule', entityType: 'household', entityId: h.id, diff: { validFrom: [prior?.valid_from ?? null, b.validFrom], kind: [prior?.kind ?? null, b.kind], fromNth: [prior?.from_nth ?? null, b.fromNth ?? null], percentBp: [prior?.percent_bp ?? null, b.percentBp ?? null], capCents: [prior?.cap_cents ?? null, b.capCents ?? null] } });
    });
    return (await dto(actor, [req.params.id]))[0]!;
  });

  app.delete('/households/:id', { schema: { tags, summary: 'Haushalt auflösen (die Mitglieder bleiben, werden wieder einzeln abgerechnet)', params: idParam, body: z.object({}).optional() } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    requireClubWide(actor, 'fees', 'write');
    await db.transaction().execute(async (tx) => {
      // Household changes alter fee inputs: never while a fee run is being posted.
      await lockFees(tx, actor.organizationId);
      const h = await tx.selectFrom('household').select(['id', 'name']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!h) throw notFound('Haushalt');
      await tx.updateTable('member').set({ household_id: null, updated_at: new Date() }).where('household_id', '=', h.id).execute();
      await tx.deleteFrom('household').where('id', '=', h.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'household.deleted', entityType: 'household', entityId: h.id, diff: { name: [h.name, null] } });
    });
    return reply.status(204).send();
  });
};
