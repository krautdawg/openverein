import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { displayName } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { notFound, Problem } from '../http/problem.ts';
import { createDraft } from '../invoices/service.ts';
import { applyScope, loadMemberRow, orgToday } from '../members/query.ts';
import { requireClubWide, requirePermission, type Actor } from '../policy.ts';

const tags = ['members'];
const settings = z.object({
  required: z.number().positive().max(200).nullable(),
  rateCents: z.number().int().min(0).max(100_000).nullable(),
  ageFrom: z.number().int().min(0).max(120).nullable(),
  ageTo: z.number().int().min(0).max(120).nullable(),
});
const entry = z.object({ id: z.uuid(), memberId: z.uuid(), workedOn: z.string(), hours: z.number(), text: z.string() });
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

export const workHourRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function loadSettings(organizationId: string) {
    const o = await db.selectFrom('organization').select(['work_hours_required', 'work_hours_rate_cents', 'work_hours_age_from', 'work_hours_age_to']).where('id', '=', organizationId).executeTakeFirstOrThrow();
    return { required: o.work_hours_required === null ? null : Number(o.work_hours_required), rateCents: o.work_hours_rate_cents === null ? null : Number(o.work_hours_rate_cents), ageFrom: o.work_hours_age_from, ageTo: o.work_hours_age_to };
  }

  /** Members of the year (by join and exit date) in the caller's scope, with hours owed, done and missing. */
  async function overview(actor: Actor, year: number) {
    const s = await loadSettings(actor.organizationId);
    const today = await orgToday(db, actor.organizationId);
    const rows = await db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.birth_date'])
      .select((eb) => eb.selectFrom('work_hour_entry').select(sql<string>`coalesce(sum(hours), 0)`.as('h')).whereRef('work_hour_entry.member_id', '=', 'member.id').where('worked_on', '>=', `${year}-01-01`).where('worked_on', '<=', `${year}-12-31`).as('done'))
      .select((eb) => eb.selectFrom('work_hour_settlement').select('invoice_id').whereRef('work_hour_settlement.member_id', '=', 'member.id').where('year', '=', year).as('invoice_id'))
      .where('member.organization_id', '=', actor.organizationId)
      .where('member.join_date', '<=', `${year}-12-31`)
      .where((eb) => eb.or([eb('member.exit_date', 'is', null), eb('member.exit_date', '>=', `${year}-01-01`)]))
      .where(applyScope(actor, today, 'read'))
      .orderBy('person.last_name').orderBy('person.first_name').execute();
    return rows.map((r) => {
      const age = r.birth_date ? year - Number(r.birth_date.slice(0, 4)) : null;
      // Organisations never owe hours; unknown ages owe them (the club can add the birth date).
      const liable = r.kind === 'natural' && s.required !== null && (age === null || ((s.ageFrom === null || age >= s.ageFrom) && (s.ageTo === null || age <= s.ageTo)));
      const required = liable ? s.required! : 0;
      const done = Number(r.done ?? 0);
      const missing = Math.max(0, Math.round((required - done) * 100) / 100);
      return { memberId: r.id, name: displayName({ kind: r.kind, firstName: r.first_name, lastName: r.last_name, companyName: r.company_name }), required, done, missing, feeCents: Math.round(missing * (s.rateCents ?? 0)), invoiceId: r.invoice_id ?? null };
    });
  }

  app.get('/work-hours/settings', { schema: { tags, summary: 'Regel für Arbeitsstunden', response: { 200: settings } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    return loadSettings(actor.organizationId);
  });

  app.put('/work-hours/settings', { schema: { tags, summary: 'Regel für Arbeitsstunden ändern (Stunden pro Jahr, Ersatzgeld je fehlender Stunde, Altersgrenzen)', body: settings, response: { 200: settings } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'settings', 'write');
    const b = req.body;
    if (b.ageFrom !== null && b.ageTo !== null && b.ageFrom > b.ageTo) throw new Problem(400, 'validation', 'Das Mindestalter liegt über dem Höchstalter.');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('organization').set({ work_hours_required: b.required === null ? null : String(b.required), work_hours_rate_cents: b.rateCents, work_hours_age_from: b.ageFrom, work_hours_age_to: b.ageTo }).where('id', '=', actor.organizationId).execute();
      await audit(tx, actor.organizationId, actor, { action: 'work_hours.settings', entityType: 'organization', entityId: actor.organizationId, diff: { rule: [null, b] } });
    });
    return loadSettings(actor.organizationId);
  });

  app.get('/work-hours', { schema: { tags, summary: 'Arbeitsstunden eines Jahres je Mitglied: Soll, geleistet, offen, Ersatzgeld', querystring: yearQuery, response: { 200: z.object({ settings, members: z.array(z.object({ memberId: z.uuid(), name: z.string(), required: z.number(), done: z.number(), missing: z.number(), feeCents: z.number(), invoiceId: z.uuid().nullable() })) }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    return { settings: await loadSettings(actor.organizationId), members: await overview(actor, req.query.year) };
  });

  app.get('/work-hours/entries', { schema: { tags, summary: 'Geleistete Stunden eines Mitglieds im Jahr', querystring: yearQuery.extend({ memberId: z.uuid() }), response: { 200: z.array(entry) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    await loadMemberRow(db, actor, req.query.memberId, 'read');
    const rows = await db.selectFrom('work_hour_entry').select(['id', 'member_id', 'worked_on', 'hours', 'text']).where('member_id', '=', req.query.memberId).where('worked_on', '>=', `${req.query.year}-01-01`).where('worked_on', '<=', `${req.query.year}-12-31`).orderBy('worked_on').execute();
    return rows.map((r) => ({ id: r.id, memberId: r.member_id, workedOn: r.worked_on, hours: Number(r.hours), text: r.text }));
  });

  app.post('/work-hours/entries', { schema: { tags, summary: 'Geleistete Stunden eintragen (Abteilungsleitungen für ihre Abteilung)', body: z.object({ memberId: z.uuid(), workedOn: z.iso.date(), hours: z.number().positive().max(24).multipleOf(0.25, 'In Viertelstunden.'), text: z.string().trim().min(1, 'Wofür?').max(200) }), response: { 201: entry } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'write');
    await loadMemberRow(db, actor, req.body.memberId, 'write');
    const e = await db.transaction().execute(async (tx) => {
      const e = await tx.insertInto('work_hour_entry').values({ organization_id: actor.organizationId, member_id: req.body.memberId, worked_on: req.body.workedOn, hours: String(req.body.hours), text: req.body.text, logged_by: actor.userId }).returning(['id', 'member_id', 'worked_on', 'hours', 'text']).executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'work_hours.logged', entityType: 'member', entityId: req.body.memberId, diff: { hours: [null, req.body.hours], on: [null, req.body.workedOn] } });
      return e;
    });
    reply.status(201);
    return { id: e.id, memberId: e.member_id, workedOn: e.worked_on, hours: Number(e.hours), text: e.text };
  });

  app.delete('/work-hours/entries/:id', { schema: { tags, summary: 'Falsch eingetragene Stunden löschen (vor der Abrechnung des Jahres)', params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'write');
    const e = await db.selectFrom('work_hour_entry').select(['id', 'member_id', 'worked_on', 'hours']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!e) throw notFound('Eintrag');
    await loadMemberRow(db, actor, e.member_id, 'write');
    // Once the year is settled, its hours are the basis of an invoice.
    if (await db.selectFrom('work_hour_settlement').select('invoice_id').where('member_id', '=', e.member_id).where('year', '=', Number(e.worked_on.slice(0, 4))).executeTakeFirst()) throw new Problem(409, 'settled', 'Das Jahr ist schon abgerechnet.', 'Korrigiere über die Ersatzgeld-Rechnung.');
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('work_hour_entry').where('id', '=', e.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'work_hours.deleted', entityType: 'member', entityId: e.member_id, diff: { hours: [Number(e.hours), null], on: [e.worked_on, null] } });
    });
    return reply.status(204).send();
  });

  app.post('/work-hours/settle', { schema: { tags, summary: 'Ersatzgeld abrechnen: je Mitglied mit fehlenden Stunden ein Rechnungsentwurf (einmal je Jahr)', body: z.object({ year: z.number().int().min(2000).max(2100) }), response: { 200: z.object({ drafted: z.number(), alreadySettled: z.number() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const { year } = req.body;
    const s = await loadSettings(actor.organizationId);
    if (s.required === null || !s.rateCents) throw new Problem(409, 'no-rule', 'Es gibt keine Regel mit Ersatzgeld.', 'Trag Stunden pro Jahr und Ersatzgeld je Stunde ein.');
    const due = (await overview(actor, year)).filter((m) => m.missing > 0);
    let drafted = 0;
    let alreadySettled = 0;
    for (const m of due) {
      if (m.invoiceId) { alreadySettled++; continue; }
      await db.transaction().execute(async (tx) => {
        const member = await tx.selectFrom('member').select(['id', 'person_id']).where('id', '=', m.memberId).executeTakeFirstOrThrow();
        const id = await createDraft(tx, { organizationId: actor.organizationId, kind: 'other', personId: member.person_id, memberId: member.id, createdBy: actor.userId }, [{ text: `Ersatzgeld Arbeitsstunden ${year} (${m.done.toLocaleString('de-DE')} von ${m.required.toLocaleString('de-DE')} Std. geleistet)`, quantity: m.missing, unitCents: s.rateCents!, taxRate: 0 }]);
        // The primary key (member, year) refuses a second settlement, also under concurrent runs.
        await tx.insertInto('work_hour_settlement').values({ organization_id: actor.organizationId, member_id: member.id, year, invoice_id: id }).execute();
        await audit(tx, actor.organizationId, actor, { action: 'work_hours.settled', entityType: 'invoice', entityId: id, diff: { year: [null, year], missing: [null, m.missing] } });
      });
      drafted++;
    }
    return { drafted, alreadySettled };
  });
};
