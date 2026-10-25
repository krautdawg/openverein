import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { addDays } from '../../shared/dates.ts';
import {
  assignment,
  assignmentInput,
  calculatorResult,
  feeRun,
  feeRunCreate,
  feeRunPost,
  feeRunSummary,
  memberFees,
  PAYMENT_METHODS,
  plan,
  planCreate,
  planPatch,
  versionInput,
  type PreviewMember,
} from '../../shared/fees.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db, FeeRunTable } from '../db.ts';
import { assess } from '../fees/engine.ts';
import { loadInputs, membersWithMandate, previewFor } from '../fees/service.ts';
import { previewHouseholds, type PreviewHousehold } from '../fees/household.ts';
import { CONSTRAINT_MESSAGES, notFound, Problem } from '../http/problem.ts';
import { cancelInvoice, createDraft, issueInvoice } from '../invoices/service.ts';
import { loadMemberRow, orgToday, scopePredicate } from '../members/query.ts';
import { requirePermission, scopeOf, type Actor } from '../policy.ts';

CONSTRAINT_MESSAGES.fee_plan_organization_id_name_key = 'Einen Beitrag mit diesem Namen gibt es schon.';
CONSTRAINT_MESSAGES.fee_plan_version_fee_plan_id_valid_from_key = 'Ab diesem Datum gibt es schon einen Preis.';
CONSTRAINT_MESSAGES.fee_assignment_one_main = 'Das Mitglied hat in diesem Zeitraum schon einen Hauptbeitrag. Beende ihn zuerst.';
CONSTRAINT_MESSAGES.fee_assignment_no_overlap = 'Das Mitglied hat diesen Beitrag in diesem Zeitraum schon.';
CONSTRAINT_MESSAGES.assessment_no_double_billing = 'Mindestens ein Zeitraum ist bereits abgerechnet. Erstelle die Vorschau neu.';

const idParam = z.object({ id: z.uuid() });
const tags = ['fees'];

export const feeRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function planDto(actor: Actor, id: string) {
    const p = await db.selectFrom('fee_plan').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!p) throw notFound('Beitrag');
    return (await plansDto(actor, [p]))[0]!;
  }

  async function plansDto(actor: Actor, plans: { id: string; name: string; line_text: string; status: 'active' | 'retired' }[]) {
    if (plans.length === 0) return [];
    const today = await orgToday(db, actor.organizationId);
    const versions = await db.selectFrom('fee_plan_version').selectAll().where('fee_plan_id', 'in', plans.map((p) => p.id)).orderBy('valid_from').execute();
    const counts = await db
      .selectFrom('fee_assignment')
      .select(['fee_plan_id', sql<number>`count(distinct member_id)::int`.as('n')])
      .where('fee_plan_id', 'in', plans.map((p) => p.id))
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', today)]))
      .groupBy('fee_plan_id')
      .execute();
    return plans.map((p) => {
      const vs = versions
        .filter((v) => v.fee_plan_id === p.id)
        .map((v) => ({ id: v.id, validFrom: v.valid_from, amountCents: v.amount_cents, intervalMonths: v.interval_months, anchor: v.anchor, proration: v.proration, admissionFeeCents: v.admission_fee_cents }));
      const current = [...vs].reverse().find((v) => v.validFrom <= today) ?? vs[0] ?? null;
      return { id: p.id, name: p.name, lineText: p.line_text, status: p.status, versions: vs, current, assignedMembers: counts.find((c) => c.fee_plan_id === p.id)?.n ?? 0 };
    });
  }

  // ---------- Plans ----------

  app.get('/fee-plans', { schema: { tags, summary: 'Beiträge mit Preisverlauf', querystring: z.object({ includeRetired: z.stringbool().optional() }), response: { 200: z.array(plan) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'read');
    let q = db.selectFrom('fee_plan').selectAll().where('organization_id', '=', actor.organizationId);
    if (!req.query.includeRetired) q = q.where('status', '=', 'active');
    return plansDto(actor, await q.orderBy('name').execute());
  });

  app.post('/fee-plans', { schema: { tags, summary: 'Beitrag mit erstem Preis anlegen', body: planCreate, response: { 201: plan } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'write');
    const id = await db.transaction().execute(async (tx) => {
      const p = await tx.insertInto('fee_plan').values({ organization_id: actor.organizationId, name: req.body.name, line_text: req.body.lineText }).returning('id').executeTakeFirstOrThrow();
      await insertVersion(tx, actor, p.id, req.body.version);
      await audit(tx, actor.organizationId, actor, { action: 'fee_plan.created', entityType: 'fee_plan', entityId: p.id, diff: { name: [null, req.body.name], version: [null, req.body.version] } });
      return p.id;
    });
    reply.status(201);
    return planDto(actor, id);
  });

  async function insertVersion(tx: Db, actor: Actor, planId: string, v: z.infer<typeof versionInput>) {
    await tx
      .insertInto('fee_plan_version')
      .values({ organization_id: actor.organizationId, fee_plan_id: planId, valid_from: v.validFrom, amount_cents: v.amountCents, interval_months: v.intervalMonths, anchor: v.anchor, proration: v.proration, admission_fee_cents: v.admissionFeeCents })
      .execute();
  }

  app.patch('/fee-plans/:id', { schema: { tags, summary: 'Name oder Positionstext ändern', params: idParam, body: planPatch, response: { 200: plan } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'write');
    const before = await planDto(actor, req.params.id);
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('fee_plan').set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.lineText ? { line_text: req.body.lineText } : {}), updated_at: new Date() }).where('id', '=', before.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'fee_plan.updated', entityType: 'fee_plan', entityId: before.id, diff: { name: [before.name, req.body.name ?? before.name], lineText: [before.lineText, req.body.lineText ?? before.lineText] } });
    });
    return planDto(actor, before.id);
  });

  app.post(
    '/fee-plans/:id/versions',
    { schema: { tags, summary: 'Neuen Preis ab einem Datum festlegen (bereits abgerechnete Zeiträume bleiben unverändert)', params: idParam, body: versionInput, response: { 201: plan } } },
    async (req, reply) => {
      const actor = requireActor(req);
      requirePermission(actor, 'fees', 'write');
      const p = await planDto(actor, req.params.id);
      // A new price may not reach back into periods that are already billed.
      const billed = await db
        .selectFrom('assessment')
        .innerJoin('fee_assignment', 'fee_assignment.id', 'assessment.assignment_id')
        .select(sql<string>`max(assessment.period_end)`.as('last'))
        .where('fee_assignment.fee_plan_id', '=', p.id)
        .where('assessment.status', '<>', 'cancelled')
        .executeTakeFirst();
      if (billed?.last && req.body.validFrom <= billed.last) {
        throw new Problem(409, 'billed-period', `Bis ${billed.last.split('-').reverse().join('.')} ist bereits abgerechnet. Ein neuer Preis gilt frühestens ab dem Tag danach.`);
      }
      await db.transaction().execute(async (tx) => {
        await insertVersion(tx, actor, p.id, req.body);
        await audit(tx, actor.organizationId, actor, { action: 'fee_plan.version_added', entityType: 'fee_plan', entityId: p.id, diff: { version: [p.current, req.body] } });
      });
      reply.status(201);
      return planDto(actor, p.id);
    },
  );

  app.post('/fee-plans/:id/retire', { schema: { tags, summary: 'Beitrag stilllegen (nicht löschbar, sobald abgerechnet)', params: idParam, body: z.object({}).optional(), response: { 200: plan } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'write');
    const p = await planDto(actor, req.params.id);
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('fee_plan').set({ status: p.status === 'active' ? 'retired' : 'active', updated_at: new Date() }).where('id', '=', p.id).execute();
      await audit(tx, actor.organizationId, actor, { action: p.status === 'active' ? 'fee_plan.retired' : 'fee_plan.reactivated', entityType: 'fee_plan', entityId: p.id });
    });
    return planDto(actor, p.id);
  });

  app.delete('/fee-plans/:id', { schema: { tags, summary: 'Nie verwendeten Beitrag löschen', params: idParam, body: z.object({}).optional(), response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'write');
    const p = await planDto(actor, req.params.id);
    const used = await db.selectFrom('fee_assignment').select('id').where('fee_plan_id', '=', p.id).executeTakeFirst();
    if (used) throw new Problem(409, 'plan-in-use', 'Der Beitrag ist Mitgliedern zugeordnet. Lege ihn still, statt ihn zu löschen.');
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('fee_plan_version').where('fee_plan_id', '=', p.id).execute();
      await tx.deleteFrom('fee_plan').where('id', '=', p.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'fee_plan.deleted', entityType: 'fee_plan', entityId: p.id, diff: { name: [p.name, null] } });
    });
    reply.status(204);
    return null;
  });

  // ---------- Member fees ----------

  async function memberFeesDto(memberId: string) {
    const m = await db.selectFrom('member').select('payment_method').where('id', '=', memberId).executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom('fee_assignment')
      .innerJoin('fee_plan', 'fee_plan.id', 'fee_assignment.fee_plan_id')
      .select(['fee_assignment.id', 'fee_assignment.fee_plan_id', 'fee_plan.name', 'fee_assignment.is_main', 'fee_assignment.valid_from', 'fee_assignment.valid_to', 'fee_assignment.first_period_start', 'fee_assignment.override_cents', 'fee_assignment.override_reason'])
      .where('fee_assignment.member_id', '=', memberId)
      .orderBy('fee_assignment.valid_from')
      .execute();
    return {
      paymentMethod: m.payment_method,
      assignments: rows.map((a) => ({ id: a.id, feePlanId: a.fee_plan_id, planName: a.name, isMain: a.is_main, validFrom: a.valid_from, validTo: a.valid_to, firstPeriodStart: a.first_period_start, overrideCents: a.override_cents, overrideReason: a.override_reason })),
    };
  }

  app.get('/members/:id/fees', { schema: { tags, summary: 'Beiträge und Zahlungsart eines Mitglieds', params: idParam, response: { 200: memberFees } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'read');
    await loadMemberRow(db, actor, req.params.id, 'read', 'fees');
    return memberFeesDto(req.params.id);
  });

  app.patch('/members/:id/payment-method', { schema: { tags, summary: 'Zahlungsart eines Mitglieds festlegen', params: idParam, body: z.object({ paymentMethod: z.enum(PAYMENT_METHODS) }), response: { 200: memberFees } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'write');
    const { row } = await loadMemberRow(db, actor, req.params.id, 'write', 'fees');
    await db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('member').select('payment_method').where('id', '=', row.id).forUpdate().executeTakeFirstOrThrow();
      await tx.updateTable('member').set({ payment_method: req.body.paymentMethod, updated_at: new Date() }).where('id', '=', row.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'member.payment_method', entityType: 'member', entityId: row.id, diff: { paymentMethod: [before.payment_method, req.body.paymentMethod] } });
    });
    return memberFeesDto(row.id);
  });

  app.post('/members/:id/fee-assignments', { schema: { tags, summary: 'Beitrag zuordnen (genau ein Hauptbeitrag zu jedem Zeitpunkt)', params: idParam, body: assignmentInput, response: { 201: assignment } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'write');
    const { row } = await loadMemberRow(db, actor, req.params.id, 'write', 'fees');
    const b = req.body;
    if (b.overrideCents != null && !b.overrideReason) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'overrideReason', message: 'Bitte begründe den individuellen Betrag.' }] });
    if (b.validTo && b.validTo < b.validFrom) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'validTo', message: 'Liegt vor dem Beginn.' }] });
    const p = await planDto(actor, b.feePlanId);
    if (p.status !== 'active') throw new Problem(409, 'plan-retired', 'Der Beitrag ist stillgelegt.');
    const id = await db.transaction().execute(async (tx) => {
      const a = await tx
        .insertInto('fee_assignment')
        .values({ organization_id: actor.organizationId, member_id: row.id, fee_plan_id: p.id, is_main: b.isMain, valid_from: b.validFrom, valid_to: b.validTo ?? null, first_period_start: b.firstPeriodStart ?? null, override_cents: b.overrideCents ?? null, override_reason: b.overrideReason ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'member.fee_assigned', entityType: 'member', entityId: row.id, diff: { plan: [null, p.name], validFrom: [null, b.validFrom], overrideCents: [null, b.overrideCents ?? null] } });
      return a.id;
    });
    reply.status(201);
    return (await memberFeesDto(row.id)).assignments.find((a) => a.id === id)!;
  });

  app.patch(
    '/fee-assignments/:id',
    { schema: { tags, summary: 'Beitragszuordnung beenden (Ende setzen)', params: idParam, body: z.object({ validTo: z.iso.date().nullable() }), response: { 200: assignment } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'fees', 'write');
      const a = await db.selectFrom('fee_assignment').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!a) throw notFound('Beitragszuordnung');
      await loadMemberRow(db, actor, a.member_id, 'write', 'fees');
      if (req.body.validTo && req.body.validTo < a.valid_from) throw new Problem(400, 'validation', 'Das Ende liegt vor dem Beginn.', undefined, { errors: [{ field: 'validTo', message: 'Liegt vor dem Beginn.' }] });
      // Ending before an already billed day would leave a billed period outside the assignment.
      const billed = await db.selectFrom('assessment').select(sql<string>`max(period_end)`.as('last')).where('assignment_id', '=', a.id).where('status', '<>', 'cancelled').executeTakeFirst();
      if (req.body.validTo && billed?.last && req.body.validTo < billed.last) {
        throw new Problem(409, 'billed-period', `Bis ${billed.last.split('-').reverse().join('.')} ist bereits abgerechnet. Storniere die Rechnung, um früher zu beenden.`);
      }
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('fee_assignment').set({ valid_to: req.body.validTo }).where('id', '=', a.id).execute();
        await audit(tx, actor.organizationId, actor, { action: 'member.fee_ended', entityType: 'member', entityId: a.member_id, diff: { validTo: [a.valid_to, req.body.validTo] } });
      });
      return (await memberFeesDto(a.member_id)).assignments.find((x) => x.id === a.id)!;
    },
  );

  app.get(
    '/members/:id/fee-calculator',
    { schema: { tags, summary: 'Was zahlt das Mitglied bis zu einem Datum, und warum? (bucht nichts)', params: idParam, querystring: z.object({ until: z.iso.date() }), response: { 200: calculatorResult } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'fees', 'read');
      const { today } = await loadMemberRow(db, actor, req.params.id, 'read', 'fees');
      const { members, versions } = await loadInputs(db, actor.organizationId, { memberIds: [req.params.id], today });
      const m = members[0];
      if (!m) return { lines: [], skipped: [], totalCents: 0 };
      const r = assess({ assignments: m.assignments, versions, billed: m.billed, until: req.query.until, exitDate: m.exitDate, today, membershipNumber: m.membershipNumber });
      return { lines: r.lines, skipped: r.skipped, totalCents: r.lines.reduce((s, l) => s + l.amountCents, 0) };
    },
  );

  // ---------- Fee runs ----------

  type Stored = { members: PreviewMember[]; households?: PreviewHousehold[] };

  async function runDto(actor: Actor, r: Selectable<FeeRunTable>) {
    let members = (r.preview as Stored).members;
    let households = (r.preview as Stored).households ?? [];
    // A scoped reader sees only the members of their groups, never the whole club's billing.
    const scope = scopeOf(actor, 'fees', 'read');
    if (scope !== null) {
      households = [];
      const today = await orgToday(db, actor.organizationId);
      const visible = new Set((await db.selectFrom('member').select('id').where('organization_id', '=', actor.organizationId).where(scopePredicate(scope, today, 'read')).execute()).map((m) => m.id));
      members = members.filter((m) => visible.has(m.memberId));
    }
    const invoiceCount = await db.selectFrom('invoice').select(sql<number>`count(*)::int`.as('n')).where('fee_run_id', '=', r.id).where('kind', '=', 'membership').executeTakeFirstOrThrow();
    return {
      id: r.id,
      until: r.until,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      groupId: r.group_id,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      postedAt: r.posted_at?.toISOString() ?? null,
      members,
      households: households.map(({ householdId, name, payerName, memberIds, discountCents, label }) => ({ householdId, name, payerName, memberIds, discountCents, label })),
      totals: {
        members: members.filter((m) => m.lines.length > 0).length,
        lines: members.reduce((s, m) => s + m.lines.length, 0),
        totalCents: members.reduce((s, m) => s + m.totalCents, 0) - households.reduce((s, h) => s + h.discountCents, 0),
        catchUpLines: members.reduce((s, m) => s + m.lines.filter((l) => l.catchUp).length, 0),
        warnings: members.filter((m) => m.warnings.length > 0).length,
      },
      invoiceCount: invoiceCount.n,
    };
  }

  async function loadRun(actor: Actor, id: string) {
    const r = await db.selectFrom('fee_run').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!r) throw notFound('Beitragslauf');
    return r;
  }

  async function computePreview(actor: Actor, until: string, groupId: string | null, conn: Db = db) {
    const today = await orgToday(conn, actor.organizationId);
    const { members, versions } = await loadInputs(conn, actor.organizationId, { groupId, today, scope: scopeOf(actor, 'fees', 'write') });
    const mandates = await membersWithMandate(conn, actor.organizationId);
    return members.map((m) => previewFor(m, versions, until, today, mandates.has(m.memberId))).filter((p) => p.lines.length > 0 || p.skipped.length > 0);
  }

  app.get('/fee-runs', { schema: { tags, summary: 'Beitragsläufe', response: { 200: z.array(feeRunSummary) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'read');
    const rows = await db.selectFrom('fee_run').selectAll().where('organization_id', '=', actor.organizationId).orderBy('created_at', 'desc').limit(50).execute();
    return Promise.all(rows.map(async (r) => {
      const { members: _members, ...rest } = await runDto(actor, r);
      return rest;
    }));
  });

  app.post('/fee-runs', { schema: { tags, summary: 'Vorschau eines Beitragslaufs erstellen (bucht noch nichts)', body: feeRunCreate, response: { 201: feeRun } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'write');
    requirePermission(actor, 'invoices', 'write');
    const today = await orgToday(db, actor.organizationId);
    const org = await db.selectFrom('organization').select('payment_terms_days').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const issueDate = req.body.issueDate ?? today;
    const dueDate = req.body.dueDate ?? addDays(issueDate, org.payment_terms_days);
    if (dueDate < issueDate) throw new Problem(400, 'validation', 'Die Fälligkeit liegt vor dem Rechnungsdatum.', undefined, { errors: [{ field: 'dueDate', message: 'Liegt vor dem Rechnungsdatum.' }] });
    const members = await computePreview(actor, req.body.until, req.body.groupId ?? null);
    const households = await previewHouseholds(db, actor.organizationId, members, issueDate);
    const r = await db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('fee_run')
        .values({ organization_id: actor.organizationId, until: req.body.until, issue_date: issueDate, due_date: dueDate, group_id: req.body.groupId ?? null, preview: JSON.stringify({ members, households }), input_hash: members.map((m) => m.hash).join(','), created_by: actor.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'fee_run.previewed', entityType: 'fee_run', entityId: r.id, diff: { until: [null, r.until], members: [null, members.length] } });
      return r;
    });
    reply.status(201);
    return runDto(actor, r);
  });

  app.get('/fee-runs/:id', { schema: { tags, summary: 'Beitragslauf mit Vorschau', params: idParam, response: { 200: feeRun } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'fees', 'read');
    return runDto(actor, await loadRun(actor, req.params.id));
  });

  app.post(
    '/fee-runs/:id/post',
    { schema: { tags, summary: 'Vorschau buchen: Abrechnungen und Rechnungen erstellen. Scheitert, wenn sich Daten seit der Vorschau geändert haben.', params: idParam, body: feeRunPost, response: { 200: feeRun } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'fees', 'write');
      requirePermission(actor, 'invoices', 'write');
      const exclude = new Set(req.body.excludeLineKeys);
      // shortcut: the whole run posts in one transaction; move to chunked background jobs above ~2,000 members.
      await db.transaction().execute(async (tx) => {
        const run = await tx.selectFrom('fee_run').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
        if (!run) throw notFound('Beitragslauf');
        if (run.status !== 'preview') throw new Problem(409, 'not-preview', 'Dieser Lauf ist bereits gebucht oder verworfen.');
        const stored = (run.preview as Stored).members;
        const current = await computePreview(actor, run.until, run.group_id, tx);
        const before = new Map(stored.map((m) => [m.memberId, m.hash]));
        const changed = current.filter((m) => before.get(m.memberId) !== m.hash).map((m) => m.name);
        const gone = stored.filter((m) => !current.some((c) => c.memberId === m.memberId)).map((m) => m.name);
        // Households: computed again with the excluded lines; a changed payer, member set, birth date or rule is stale.
        const households = await previewHouseholds(tx, actor.organizationId, current, run.issue_date, exclude);
        const storedHouseholds = new Map(((run.preview as Stored).households ?? []).map((h) => [h.householdId, h.hash]));
        const hhChanged = [...households.filter((h) => storedHouseholds.get(h.householdId) !== h.hash), ...[...storedHouseholds.keys()].filter((id) => !households.some((h) => h.householdId === id)).map((id) => ({ name: `Haushalt ${id.slice(0, 8)}` }))].map((h) => h.name);
        if (changed.length || gone.length || hhChanged.length) {
          const all = [...changed, ...gone, ...hhChanged];
          throw new Problem(409, 'stale-preview', 'Daten haben sich seit der Vorschau geändert.', `Betroffen: ${all.slice(0, 5).join(', ')}${all.length > 5 ? ' …' : ''}. Bitte erstelle die Vorschau neu.`);
        }
        const householdOf = new Map(households.flatMap((h) => h.memberIds.map((id) => [id, h] as const)));
        const persons = new Map(
          (await tx.selectFrom('member').select(['id', 'person_id']).where('id', 'in', current.length ? current.map((m) => m.memberId) : ['00000000-0000-0000-0000-000000000000']).execute()).map((m) => [m.id, m.person_id]),
        );
        let invoices = 0;
        type Created = { text: string; quantity: number; unitCents: number; taxRate: number; assessmentId?: string; discount?: boolean };
        const perHousehold = new Map<string, Created[]>();
        for (const m of current) {
          const lines = m.lines.filter((l) => !exclude.has(l.key));
          if (lines.length === 0) continue;
          const hh = householdOf.get(m.memberId);
          const created: Created[] = [];
          for (const l of lines) {
            const a = await tx
              .insertInto('assessment')
              .values({
                organization_id: actor.organizationId,
                member_id: m.memberId,
                assignment_id: l.assignmentId,
                fee_run_id: run.id,
                charge_slot: l.slot,
                period_start: l.periodStart,
                period_end: l.periodEnd,
                amount_cents: l.amountCents,
                snapshot: JSON.stringify(l),
              })
              .returning('id')
              .executeTakeFirstOrThrow();
            created.push({ text: hh ? `${m.name}: ${l.text}` : l.text, quantity: 1, unitCents: l.amountCents, taxRate: 0, assessmentId: a.id });
          }
          if (hh) {
            perHousehold.set(hh.householdId, [...(perHousehold.get(hh.householdId) ?? []), ...created]);
            continue;
          }
          if (created.reduce((s, c) => s + c.unitCents, 0) === 0) continue;
          const invId = await createDraft(tx, { organizationId: actor.organizationId, kind: 'membership', personId: persons.get(m.memberId)!, memberId: m.memberId, dueDate: run.due_date, feeRunId: run.id, createdBy: actor.userId }, created);
          await issueInvoice(tx, actor.organizationId, invId, run.issue_date, run.due_date);
          invoices++;
        }
        // One invoice per household to the payer, with the family discount as its own line.
        for (const h of households) {
          const created = perHousehold.get(h.householdId) ?? [];
          if (!created.length) continue;
          if (h.discountCents > 0) created.push({ text: h.label, quantity: 1, unitCents: -h.discountCents, taxRate: 0, discount: true });
          if (created.reduce((s, c) => s + c.unitCents, 0) <= 0) continue;
          const invId = await createDraft(tx, { organizationId: actor.organizationId, kind: 'membership', personId: h.payerPersonId, memberId: h.anchorMemberId, dueDate: run.due_date, feeRunId: run.id, coverText: `Beiträge für den Haushalt ${h.name}`, createdBy: actor.userId }, created);
          await issueInvoice(tx, actor.organizationId, invId, run.issue_date, run.due_date);
          invoices++;
        }
        await tx.updateTable('fee_run').set({ status: 'posted', posted_at: new Date() }).where('id', '=', run.id).execute();
        await audit(tx, actor.organizationId, actor, { action: 'fee_run.posted', entityType: 'fee_run', entityId: run.id, diff: { invoices: [null, invoices], excluded: [null, [...exclude]] } });
      });
      return runDto(actor, await loadRun(actor, req.params.id));
    },
  );

  app.post(
    '/fee-runs/:id/cancel',
    { schema: { tags, summary: 'Vorschau verwerfen oder gebuchten Lauf mit Stornorechnungen aufheben', params: idParam, body: z.object({}).optional(), response: { 200: feeRun } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'fees', 'write');
      requirePermission(actor, 'invoices', 'write');
      // A run spans the whole selection; only someone allowed to write for every member may undo it.
      if (scopeOf(actor, 'fees', 'write') !== null || scopeOf(actor, 'invoices', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Einen Beitragslauf aufheben dürfen nur Zugänge für den ganzen Verein.', { permission: 'fees:write (ganzer Verein)' });
      const today = await orgToday(db, actor.organizationId);
      await db.transaction().execute(async (tx) => {
        const run = await tx.selectFrom('fee_run').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
        if (!run) throw notFound('Beitragslauf');
        if (run.status === 'cancelled') throw new Problem(409, 'already-cancelled', 'Der Lauf ist bereits aufgehoben.');
        let cancelled = 0;
        if (run.status === 'posted') {
          const invoices = await tx.selectFrom('invoice').select(['id', 'status']).where('fee_run_id', '=', run.id).where('kind', '=', 'membership').execute();
          for (const inv of invoices) {
            if (inv.status === 'cancelled') continue;
            await cancelInvoice(tx, actor.organizationId, inv.id, today, actor.userId);
            cancelled++;
          }
          // Assessments without an invoice (0 € lines) are freed as well.
          await tx.updateTable('assessment').set({ status: 'cancelled' }).where('fee_run_id', '=', run.id).execute();
        }
        await tx.updateTable('fee_run').set({ status: 'cancelled', cancelled_at: new Date() }).where('id', '=', run.id).execute();
        await audit(tx, actor.organizationId, actor, { action: 'fee_run.cancelled', entityType: 'fee_run', entityId: run.id, diff: { cancelledInvoices: [null, cancelled] } });
      });
      return runDto(actor, await loadRun(actor, req.params.id));
    },
  );
};
