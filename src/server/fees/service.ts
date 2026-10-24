import { createHash } from 'node:crypto';
import { displayName } from '../../shared/members.ts';
import type { PreviewMember } from '../../shared/fees.ts';
import type { Db, PaymentMethod } from '../db.ts';
import { scopePredicate } from '../members/query.ts';
import { assess, type Assignment, type BilledRange, type PlanVersion } from './engine.ts';

export interface MemberInputs {
  memberId: string;
  personId: string;
  name: string;
  membershipNumber: string;
  status: string;
  exitDate: string | null;
  paymentMethod: PaymentMethod;
  assignments: Assignment[];
  billed: BilledRange[];
}

/** Loads everything the engine needs for a set of members in four queries. */
export async function loadInputs(db: Db, organizationId: string, opts: { memberIds?: string[]; groupId?: string | null; today: string; scope?: string[] | null }) {
  let q = db
    .selectFrom('member')
    .innerJoin('person', 'person.id', 'member.person_id')
    .select(['member.id', 'member.person_id', 'member.membership_number', 'member.status', 'member.exit_date', 'member.payment_method', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
    .where('member.organization_id', '=', organizationId)
    .where('member.status', 'not in', ['applicant', 'rejected']);
  if (opts.memberIds) q = q.where('member.id', 'in', opts.memberIds.length ? opts.memberIds : ['00000000-0000-0000-0000-000000000000']);
  if (opts.groupId) q = q.where(scopePredicate([opts.groupId], opts.today, 'write'));
  if (opts.scope) q = q.where(scopePredicate(opts.scope, opts.today, 'read'));
  const members = await q.orderBy('person.last_name').orderBy('person.first_name').execute();
  const ids = members.map((m) => m.id);
  if (ids.length === 0) return { members: [] as MemberInputs[], versions: new Map<string, PlanVersion[]>() };

  const assignments = await db
    .selectFrom('fee_assignment')
    .innerJoin('fee_plan', 'fee_plan.id', 'fee_assignment.fee_plan_id')
    .select(['fee_assignment.id', 'fee_assignment.member_id', 'fee_assignment.fee_plan_id', 'fee_plan.name', 'fee_plan.line_text', 'fee_assignment.is_main', 'fee_assignment.valid_from', 'fee_assignment.valid_to', 'fee_assignment.first_period_start', 'fee_assignment.override_cents'])
    .where('fee_assignment.member_id', 'in', ids)
    .orderBy('fee_assignment.valid_from')
    .execute();
  const planIds = [...new Set(assignments.map((a) => a.fee_plan_id))];
  const versionRows = planIds.length
    ? await db.selectFrom('fee_plan_version').selectAll().where('fee_plan_id', 'in', planIds).orderBy('valid_from').execute()
    : [];
  const versions = new Map<string, PlanVersion[]>();
  for (const v of versionRows) {
    const list = versions.get(v.fee_plan_id) ?? [];
    list.push({ validFrom: v.valid_from, amountCents: v.amount_cents, intervalMonths: v.interval_months, anchor: v.anchor, proration: v.proration, admissionFeeCents: v.admission_fee_cents });
    versions.set(v.fee_plan_id, list);
  }
  const billedRows = await db
    .selectFrom('assessment')
    .select(['member_id', 'charge_slot', 'period_start', 'period_end'])
    .where('member_id', 'in', ids)
    .where('status', '<>', 'cancelled')
    .orderBy('period_start')
    .execute();

  return {
    versions,
    members: members.map<MemberInputs>((m) => ({
      memberId: m.id,
      personId: m.person_id,
      name: displayName({ kind: m.kind, firstName: m.first_name, lastName: m.last_name, companyName: m.company_name }),
      membershipNumber: m.membership_number,
      status: m.status,
      exitDate: m.exit_date,
      paymentMethod: m.payment_method,
      assignments: assignments
        .filter((a) => a.member_id === m.id)
        .map((a) => ({ id: a.id, planId: a.fee_plan_id, planName: a.name, lineText: a.line_text, isMain: a.is_main, validFrom: a.valid_from, validTo: a.valid_to, firstPeriodStart: a.first_period_start, overrideCents: a.override_cents })),
      billed: billedRows.filter((b) => b.member_id === m.id).map((b) => ({ slot: b.charge_slot, start: b.period_start, end: b.period_end })),
    })),
  };
}

/**
 * Hash of every input that decides what a member is billed. Posting re-computes it; any difference
 * means the data changed since the preview.
 */
export function inputHash(m: MemberInputs, versions: Map<string, PlanVersion[]>, until: string) {
  const plans = [...new Set(m.assignments.map((a) => a.planId))].sort().map((p) => [p, versions.get(p)]);
  return createHash('sha256').update(JSON.stringify([until, m.membershipNumber, m.exitDate, m.paymentMethod, m.assignments, m.billed, plans])).digest('hex').slice(0, 32);
}

export function previewFor(m: MemberInputs, versions: Map<string, PlanVersion[]>, until: string, today: string, hasMandate: boolean): PreviewMember {
  const { lines, skipped } = assess({ assignments: m.assignments, versions, billed: m.billed, until, exitDate: m.exitDate, today, membershipNumber: m.membershipNumber });
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  const warnings: string[] = [];
  if (lines.length > 0) {
    if (m.paymentMethod === 'none') warnings.push('Keine Zahlungsart festgelegt.');
    if (m.paymentMethod === 'direct_debit' && !hasMandate) warnings.push('Lastschrift gewählt, aber kein aktives SEPA-Mandat.');
    if (total === 0) warnings.push('Betrag 0 €: es wird keine Rechnung erstellt.');
    if (m.status === 'resigned') warnings.push(`Gekündigt zum ${m.exitDate?.split('-').reverse().join('.')}.`);
  }
  return {
    memberId: m.memberId,
    name: m.name,
    membershipNumber: m.membershipNumber,
    paymentMethod: m.paymentMethod,
    lines: lines.map(({ key, assignmentId, slot, kind, periodStart, periodEnd, amountCents, fullCents, catchUp, text, explanation }) => ({ key, assignmentId, slot, kind, periodStart, periodEnd, amountCents, fullCents, catchUp, text, explanation })),
    skipped,
    warnings,
    totalCents: total,
    hash: inputHash(m, versions, until),
  };
}

/** Members with an active SEPA mandate. Mandates arrive with the SEPA slice; until then nobody has one. */
export async function membersWithMandate(_db: Db, _organizationId: string): Promise<Set<string>> {
  return new Set();
}
