import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { displayName } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { forbidden, notFound, Problem } from '../http/problem.ts';
import { createDraft } from '../invoices/service.ts';
import { applyScope, loadMemberRow, orgToday } from '../members/query.ts';
import type { Db } from '../db.ts';
import { requireClubWide, requirePermission, restrictedFields, type Actor } from '../policy.ts';

const tags = ['members'];
const settings = z.object({
  required: z.number().positive().max(200).nullable(),
  rateCents: z.number().int().min(0).max(100_000).nullable(),
  ageFrom: z.number().int().min(0).max(120).nullable(),
  ageTo: z.number().int().min(0).max(120).nullable(),
});
const entry = z.object({ id: z.uuid(), memberId: z.uuid(), workedOn: z.string(), hours: z.number(), text: z.string() });
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

/** Entries and the settlement of one member and year never interleave. */
const lockMemberYear = (tx: Db, memberId: string, year: number) => sql`select pg_advisory_xact_lock(hashtext(${`work-hours:${memberId}:${year}`}))`.execute(tx);
const settledIn = (tx: Db, memberId: string, year: number) => tx.selectFrom('work_hour_settlement').select('invoice_id').where('member_id', '=', memberId).where('year', '=', year).executeTakeFirst();

export const workHourRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** The rule of a year: the latest one that starts in or before it. */
  async function loadSettings(organizationId: string, year: number, conn: Db = db) {
    const r = await conn.selectFrom('work_hour_rule').selectAll().where('organization_id', '=', organizationId).where('from_year', '<=', year).orderBy('from_year', 'desc').executeTakeFirst();
    return { required: r?.required == null ? null : Number(r.required), rateCents: r?.rate_cents == null ? null : Number(r.rate_cents), ageFrom: r?.age_from ?? null, ageTo: r?.age_to ?? null };
  }
  const yearOf = async (organizationId: string) => Number((await orgToday(db, organizationId)).slice(0, 4));

  /** Members of the year (by join and exit date) in the caller's scope, with hours owed, done and missing. */
  async function overview(actor: Actor, year: number, conn: Db = db, memberId?: string) {
    const s = await loadSettings(actor.organizationId, year, conn);
    // With age limits, who owes hours in which year gives birth years away.
    if ((s.ageFrom !== null || s.ageTo !== null) && restrictedFields(actor).has('birth_date')) throw forbidden('members.field.birth_date');
    const today = await orgToday(conn, actor.organizationId);
    const rows = await conn.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.birth_date'])
      .select((eb) => eb.selectFrom('work_hour_entry').select(sql<string>`coalesce(sum(hours), 0)`.as('h')).whereRef('work_hour_entry.member_id', '=', 'member.id').where('worked_on', '>=', `${year}-01-01`).where('worked_on', '<=', `${year}-12-31`).as('done'))
      .select((eb) => eb.selectFrom('work_hour_settlement').select('invoice_id').whereRef('work_hour_settlement.member_id', '=', 'member.id').where('year', '=', year).as('invoice_id'))
      .where('member.organization_id', '=', actor.organizationId)
      .where('member.join_date', '<=', `${year}-12-31`)
      .where((eb) => eb.or([eb('member.exit_date', 'is', null), eb('member.exit_date', '>=', `${year}-01-01`)]))
      .where(applyScope(actor, today, 'read'))
      .$if(!!memberId, (q) => q.where('member.id', '=', memberId!))
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

  app.get('/work-hours/settings', { schema: { tags, summary: 'Regel für Arbeitsstunden eines Jahres (ohne Jahr: das laufende)', querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), response: { 200: settings } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    return loadSettings(actor.organizationId, req.query.year ?? (await yearOf(actor.organizationId)));
  });

  app.put('/work-hours/settings', { config: { agent: { modules: ['settings'] } }, schema: { tags, summary: 'Regel für Arbeitsstunden ab einem Jahr festlegen (gilt bis zur nächsten Regel; abgerechnete Jahre behalten ihre Werte)', body: settings.extend({ fromYear: z.number().int().min(2000).max(2100).optional() }), response: { 200: settings } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'settings', 'write');
    const b = req.body;
    if (b.ageFrom !== null && b.ageTo !== null && b.ageFrom > b.ageTo) throw new Problem(400, 'validation', 'Das Mindestalter liegt über dem Höchstalter.');
    const fromYear = b.fromYear ?? (await yearOf(actor.organizationId));
    const values = { required: b.required === null ? null : String(b.required), rate_cents: b.rateCents === null ? null : String(b.rateCents), age_from: b.ageFrom, age_to: b.ageTo };
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('work_hour_rule').values({ organization_id: actor.organizationId, from_year: fromYear, ...values }).onConflict((oc) => oc.columns(['organization_id', 'from_year']).doUpdateSet(values)).execute();
      await audit(tx, actor.organizationId, actor, { action: 'work_hours.settings', entityType: 'organization', entityId: actor.organizationId, diff: { fromYear: [null, fromYear], rule: [null, { required: b.required, rateCents: b.rateCents, ageFrom: b.ageFrom, ageTo: b.ageTo }] } });
    });
    return loadSettings(actor.organizationId, fromYear);
  });

  app.get('/work-hours', { schema: { tags, summary: 'Arbeitsstunden eines Jahres je Mitglied: Soll, geleistet, offen, Ersatzgeld', querystring: yearQuery, response: { 200: z.object({ settings, members: z.array(z.object({ memberId: z.uuid(), name: z.string(), required: z.number(), done: z.number(), missing: z.number(), feeCents: z.number(), invoiceId: z.uuid().nullable() })) }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    return { settings: await loadSettings(actor.organizationId, req.query.year), members: await overview(actor, req.query.year) };
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
      // A settled year is the basis of an invoice: no more hours for it.
      const year = Number(req.body.workedOn.slice(0, 4));
      await lockMemberYear(tx, req.body.memberId, year);
      if (await settledIn(tx, req.body.memberId, year)) throw new Problem(409, 'settled', `${year} ist schon abgerechnet.`, 'Korrigiere über die Ersatzgeld-Rechnung.');
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
    await db.transaction().execute(async (tx) => {
      // Once the year is settled, its hours are the basis of an invoice.
      const year = Number(e.worked_on.slice(0, 4));
      await lockMemberYear(tx, e.member_id, year);
      if (await settledIn(tx, e.member_id, year)) throw new Problem(409, 'settled', 'Das Jahr ist schon abgerechnet.', 'Korrigiere über die Ersatzgeld-Rechnung.');
      await tx.deleteFrom('work_hour_entry').where('id', '=', e.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'work_hours.deleted', entityType: 'member', entityId: e.member_id, diff: { hours: [Number(e.hours), null], on: [e.worked_on, null] } });
    });
    return reply.status(204).send();
  });

  app.post('/work-hours/settle', { config: { agent: { modules: ['members', 'invoices'] } }, schema: { tags, summary: 'Ersatzgeld abrechnen: je Mitglied mit fehlenden Stunden ein Rechnungsentwurf (einmal je Jahr)', body: z.object({ year: z.number().int().min(2000).max(2100) }), response: { 200: z.object({ drafted: z.number(), alreadySettled: z.number() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const { year } = req.body;
    // Only a finished year: before its end nobody has had the chance to do the hours.
    if (`${year}-12-31` >= (await orgToday(db, actor.organizationId))) throw new Problem(409, 'year-open', `${year} ist noch nicht vorbei.`, 'Ersatzgeld lässt sich erst nach dem Jahresende abrechnen.');
    const s = await loadSettings(actor.organizationId, year);
    if (s.required === null || !s.rateCents) throw new Problem(409, 'no-rule', 'Es gibt keine Regel mit Ersatzgeld.', 'Trag Stunden pro Jahr und Ersatzgeld je Stunde ein.');
    const due = (await overview(actor, year)).filter((m) => m.missing > 0);
    let drafted = 0;
    let alreadySettled = 0;
    for (const m of due) {
      if (m.invoiceId) { alreadySettled++; continue; }
      const made = await db.transaction().execute(async (tx) => {
        // Recomputed under locks: hours, the member's dates and age and the rule are read as they are now, and none of
        // them changes until the draft exists (Codex review G17).
        await lockMemberYear(tx, m.memberId, year);
        if (await settledIn(tx, m.memberId, year)) return 'settled';
        await tx.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select('member.id').where('member.id', '=', m.memberId).forShare().execute();
        await tx.selectFrom('work_hour_rule').select('from_year').where('organization_id', '=', actor.organizationId).forShare().execute();
        const now = (await overview(actor, year, tx, m.memberId))[0];
        if (!now) return 'none';
        const rule = await loadSettings(actor.organizationId, year, tx);
        if (rule.required === null || !rule.rateCents) return 'none';
        const done = Number((await tx.selectFrom('work_hour_entry').select(sql<string>`coalesce(sum(hours), 0)`.as('h')).where('member_id', '=', m.memberId).where('worked_on', '>=', `${year}-01-01`).where('worked_on', '<=', `${year}-12-31`).executeTakeFirstOrThrow()).h);
        const missing = Math.max(0, Math.round((now.required - done) * 100) / 100);
        if (missing <= 0) return 'none';
        const member = await tx.selectFrom('member').select(['id', 'person_id']).where('id', '=', m.memberId).executeTakeFirstOrThrow();
        const id = await createDraft(tx, { organizationId: actor.organizationId, kind: 'other', personId: member.person_id, memberId: member.id, createdBy: actor.userId }, [{ text: `Ersatzgeld Arbeitsstunden ${year} (${done.toLocaleString('de-DE')} von ${now.required.toLocaleString('de-DE')} Std. geleistet)`, quantity: missing, unitCents: rule.rateCents, taxRate: 0 }]);
        // The primary key (member, year) refuses a second settlement, also under concurrent runs.
        await tx.insertInto('work_hour_settlement').values({ organization_id: actor.organizationId, member_id: member.id, year, invoice_id: id, required: String(now.required), done: String(done), missing: String(missing), rate_cents: String(rule.rateCents) }).execute();
        await audit(tx, actor.organizationId, actor, { action: 'work_hours.settled', entityType: 'invoice', entityId: id, diff: { year: [null, year], missing: [null, missing] } });
        return 'drafted';
      });
      if (made === 'drafted') drafted++;
      if (made === 'settled') alreadySettled++;
    }
    return { drafted, alreadySettled };
  });
};
