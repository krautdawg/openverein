/**
 * Fee engine: pure functions, no I/O. Given a member's fee assignments, the plan versions, the periods
 * already billed and a cut-off date, it returns the lines to bill and why. The database exclusion
 * constraint on `assessment` is the second line of defence against billing a day twice.
 */
import { addDays, addMonths, addMonthsKeepDay, formatDate, maxDate, minDate, monthDiff, monthsTouched } from '../../shared/dates.ts';

export interface PlanVersion {
  validFrom: string;
  amountCents: number;
  /** null = one-off charge */
  intervalMonths: number | null;
  anchor: 'calendar' | 'entry';
  proration: 'none' | 'month';
  admissionFeeCents: number;
}

export interface Assignment {
  id: string;
  planId: string;
  planName: string;
  lineText: string;
  isMain: boolean;
  validFrom: string;
  validTo: string | null;
  firstPeriodStart: string | null;
  overrideCents: number | null;
}

export interface BilledRange {
  slot: string;
  start: string;
  end: string;
}

export interface Line {
  /** Stable key: the same inputs give the same key, so a preview line can be excluded and recognised at posting. */
  key: string;
  assignmentId: string;
  planId: string;
  slot: string;
  kind: 'fee' | 'admission';
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  /** price of a full period (for the explanation) */
  fullCents: number;
  catchUp: boolean;
  text: string;
  explanation: string;
}

export interface Skipped {
  slot: string;
  periodStart: string;
  periodEnd: string;
  reason: string;
}

export interface AssessInput {
  assignments: Assignment[];
  versions: Map<string, PlanVersion[]>;
  billed: BilledRange[];
  /** bill every period that starts on or before this date */
  until: string;
  /** the member's last day (exit date), if any */
  exitDate: string | null;
  /** today in the club's time zone: periods that already ended are catch-up lines */
  today: string;
  membershipNumber: string;
}

export const slotOf = (a: Pick<Assignment, 'isMain' | 'planId'>) => (a.isMain ? 'main' : `plan:${a.planId}`);

function versionAt(versions: PlanVersion[], date: string) {
  let found: PlanVersion | undefined;
  for (const v of versions) if (v.validFrom <= date && (!found || v.validFrom > found.validFrom)) found = v;
  return found;
}

/** The period of `n` months that contains `date`: calendar grid from 1 January, or counted from `origin`. */
export function periodContaining(date: string, n: number, anchor: 'calendar' | 'entry', origin: string): [string, string] {
  if (anchor === 'calendar') {
    // Grid from 1 January of the origin's year, so periods longer than a year stay aligned.
    const gridStart = `${origin.slice(0, 4)}-01-01`;
    const k = Math.floor(monthDiff(gridStart, date) / n);
    const start = addMonths(gridStart, k * n);
    return [start, addDays(addMonths(start, n), -1)];
  }
  const k = Math.floor(monthDiffDays(origin, date) / n);
  const start = addMonthsKeepDay(origin, k * n);
  return [start, addDays(addMonthsKeepDay(origin, (k + 1) * n), -1)];
}

/** Whole months from `origin` to `date` counted on the origin's day of month (entry anchor). */
function monthDiffDays(origin: string, date: string) {
  let m = monthDiff(origin, date);
  if (addMonthsKeepDay(origin, m) > date) m -= 1;
  return m;
}

/** Parts of [start, end] not covered by any of the ranges. */
export function uncovered(start: string, end: string, ranges: { start: string; end: string }[]): [string, string][] {
  let parts: [string, string][] = [[start, end]];
  for (const r of ranges) {
    const next: [string, string][] = [];
    for (const [s, e] of parts) {
      if (r.end < s || r.start > e) {
        next.push([s, e]);
        continue;
      }
      if (r.start > s) next.push([s, addDays(r.start, -1)]);
      if (r.end < e) next.push([addDays(r.end, 1), e]);
    }
    parts = next;
  }
  return parts;
}

export function renderLineText(template: string, values: { plan: string; start: string; end: string; memberNumber: string }) {
  return template
    .replaceAll('{plan}', values.plan)
    .replaceAll('{period_start}', formatDate(values.start))
    .replaceAll('{period_end}', formatDate(values.end))
    .replaceAll('{member_number}', values.memberNumber);
}

const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

export function assess(input: AssessInput): { lines: Line[]; skipped: Skipped[] } {
  const lines: Line[] = [];
  const skipped: Skipped[] = [];

  for (const a of input.assignments) {
    const versions = input.versions.get(a.planId) ?? [];
    const slot = slotOf(a);
    const billed = input.billed.filter((b) => b.slot === slot);
    const start = maxDate(a.firstPeriodStart ?? a.validFrom, a.validFrom);
    const ends = [a.validTo, input.exitDate].filter((d): d is string => !!d);
    const last = ends.length ? ends.reduce(minDate) : null;
    if (last && last < start) continue;

    const first = versionAt(versions, start);
    if (!first) {
      skipped.push({ slot, periodStart: start, periodEnd: start, reason: `Für „${a.planName}“ gibt es zum ${formatDate(start)} noch keinen Preis.` });
      continue;
    }

    // Admission fee: once, with the first period of the assignment.
    if (first.admissionFeeCents > 0 && start <= input.until) {
      const admissionSlot = `admission:${a.planId}`;
      if (input.billed.some((b) => b.slot === admissionSlot)) {
        skipped.push({ slot: admissionSlot, periodStart: start, periodEnd: start, reason: 'Aufnahmegebühr bereits berechnet.' });
      } else {
        lines.push({
          key: `${a.id}:admission`,
          assignmentId: a.id,
          planId: a.planId,
          slot: admissionSlot,
          kind: 'admission',
          periodStart: start,
          periodEnd: start,
          amountCents: first.admissionFeeCents,
          fullCents: first.admissionFeeCents,
          catchUp: false,
          text: `Aufnahmegebühr ${a.planName}`,
          explanation: `Einmalige Aufnahmegebühr ${euro(first.admissionFeeCents)}.`,
        });
      }
    }

    let cursor = start;
    // Hard cap on iterations: a 60-year membership at 1 month is 720 periods.
    for (let guard = 0; guard < 1000 && cursor <= input.until && (!last || cursor <= last); guard++) {
      const v = versionAt(versions, cursor);
      if (!v) break;
      const full = a.overrideCents ?? v.amountCents;

      if (v.intervalMonths === null) {
        // One-off: billed exactly once, on the assignment's start.
        if (billed.length) skipped.push({ slot, periodStart: start, periodEnd: start, reason: 'Einmalbeitrag bereits berechnet.' });
        else lines.push(line(a, slot, start, start, full, full, `Einmalbeitrag ${euro(full)}.`));
        break;
      }

      const n = v.intervalMonths;
      const [ps, pe] = periodContaining(cursor, n, v.anchor, start);
      const segEnd = last ? minDate(pe, last) : pe;
      const parts = uncovered(cursor, segEnd, billed);
      if (parts.length === 0) {
        skipped.push({ slot, periodStart: cursor, periodEnd: segEnd, reason: 'Zeitraum bereits berechnet.' });
      }
      for (const [s, e] of parts) {
        const whole = s === ps && e === pe;
        const trimmedByBilling = s !== cursor || e !== segEnd;
        let amount = full;
        let why = `${euro(full)} je ${n === 1 ? 'Monat' : `${n} Monate`}`;
        if (!whole && (v.proration === 'month' || trimmedByBilling)) {
          const months = Math.min(monthsTouched(s, e), n);
          amount = Math.round((full * months) / n);
          why += `, anteilig ${months} von ${n} Monaten`;
        } else if (!whole) {
          why += ', voller Beitrag (keine anteilige Berechnung)';
        }
        if (a.overrideCents !== null) why += ', individueller Betrag';
        lines.push(line(a, slot, s, e, amount, full, why + '.'));
      }
      cursor = addDays(pe, 1);
    }
  }

  return { lines, skipped };

  function line(a: Assignment, slot: string, s: string, e: string, amount: number, full: number, explanation: string): Line {
    return {
      key: `${a.id}:${s}`,
      assignmentId: a.id,
      planId: a.planId,
      slot,
      kind: 'fee',
      periodStart: s,
      periodEnd: e,
      amountCents: amount,
      fullCents: full,
      catchUp: e < input.today,
      text: renderLineText(a.lineText, { plan: a.planName, start: s, end: e, memberNumber: input.membershipNumber }),
      explanation,
    };
  }
}
