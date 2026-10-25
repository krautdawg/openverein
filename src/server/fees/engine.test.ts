import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../shared/dates.ts';
import { ageOn, assess, periodContaining, uncovered, type Assignment, type PlanVersion } from './engine.ts';

const plan = (over: Partial<PlanVersion> = {}): PlanVersion => ({ validFrom: '2000-01-01', amountCents: 12000, intervalMonths: 12, anchor: 'calendar', proration: 'month', admissionFeeCents: 0, ...over });
const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: 'a1', planId: 'p1', planName: 'Erwachsene', lineText: '{plan} {period_start}–{period_end}', isMain: true, validFrom: '2026-01-01', validTo: null, firstPeriodStart: null, overrideCents: null, ...over,
});
const run = (a: Assignment[], versions: PlanVersion[] | Map<string, PlanVersion[]>, extra: Partial<Parameters<typeof assess>[0]> = {}) =>
  assess({ assignments: a, versions: versions instanceof Map ? versions : new Map([['p1', versions]]), billed: [], until: '2026-12-31', exitDate: null, today: '2026-06-15', membershipNumber: '0042', ...extra });

describe('periods', () => {
  it('calendar quarters and entry months', () => {
    expect(periodContaining('2026-05-10', 3, 'calendar', '2026-01-01')).toEqual(['2026-04-01', '2026-06-30']);
    expect(periodContaining('2026-05-10', 1, 'entry', '2026-03-15')).toEqual(['2026-04-15', '2026-05-14']);
    expect(periodContaining('2027-02-01', 24, 'calendar', '2026-03-01')).toEqual(['2026-01-01', '2027-12-31']);
  });
  it('uncovered parts', () => {
    expect(uncovered('2026-01-01', '2026-12-31', [{ start: '2026-04-01', end: '2026-06-30' }])).toEqual([['2026-01-01', '2026-03-31'], ['2026-07-01', '2026-12-31']]);
  });
});

describe('assess', () => {
  it('picks the age bracket by the age at the start of each period; an individual amount wins', () => {
    const brackets = { ageBrackets: [{ upToAge: 17, amountCents: 6000 }] };
    const yearly = (birthDate: string) => run([assignment({ validFrom: '2026-01-01' })], [plan(brackets)], { birthDate }).lines.map((l) => l.amountCents);
    expect(yearly('2010-06-01')).toEqual([6000]);
    expect(yearly('2008-06-01')).toEqual([6000]);
    expect(yearly('2008-01-01')).toEqual([12000]);
    expect(run([assignment({ validFrom: '2026-01-01' })], [plan(brackets)]).lines[0]!.amountCents).toBe(12000);
    expect(run([assignment({ validFrom: '2026-01-01', overrideCents: 1000 })], [plan(brackets)], { birthDate: '2010-06-01' }).lines[0]!.amountCents).toBe(1000);
    // Monthly: the 18th birthday on 15 March moves the April period to the adult amount.
    const monthly = run([assignment({ validFrom: '2026-01-01' })], [plan({ amountCents: 1000, intervalMonths: 1, ageBrackets: [{ upToAge: 17, amountCents: 500 }] })], { birthDate: '2008-03-15', until: '2026-04-30' });
    expect(monthly.lines.map((l) => l.amountCents)).toEqual([500, 500, 500, 1000]);
    expect(monthly.lines[0]!.explanation).toContain('Altersstufe bis 17 Jahre');
  });

  it('counts completed years, 29 February from 1 March', () => {
    expect(ageOn('2000-02-29', '2026-02-28')).toBe(25);
    expect(ageOn('2000-02-29', '2026-03-01')).toBe(26);
    expect(ageOn('2008-03-15', '2026-03-15')).toBe(18);
  });

  it('splits a prorated period where a new price starts (mid-month: from the next month)', () => {
    const { lines } = run([assignment({ validFrom: '2026-01-01' })], [plan({ validFrom: '2000-01-01', amountCents: 12000 }), plan({ validFrom: '2026-07-15', amountCents: 24000 })]);
    expect(lines.map((l) => [l.periodStart, l.periodEnd, l.amountCents])).toEqual([['2026-01-01', '2026-07-31', 7000], ['2026-08-01', '2026-12-31', 10000]]);
  });

  it('keeps a whole period at the old price without proration (the new price starts with the next period)', () => {
    const { lines } = run([assignment({ validFrom: '2026-01-01' })], [plan({ validFrom: '2000-01-01', proration: 'none' }), plan({ validFrom: '2026-07-01', amountCents: 24000, proration: 'none' })]);
    expect(lines.map((l) => [l.periodStart, l.periodEnd, l.amountCents])).toEqual([['2026-01-01', '2026-12-31', 12000]]);
  });

  it('bills a full year and renders the line text', () => {
    const { lines } = run([assignment()], [plan()]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-12-31', amountCents: 12000, text: 'Erwachsene 01.01.2026–31.12.2026' });
  });

  it('prorates a mid-year join by month (join month counts)', () => {
    const { lines } = run([assignment({ validFrom: '2026-05-10' })], [plan()]);
    expect(lines[0]).toMatchObject({ periodStart: '2026-05-10', periodEnd: '2026-12-31', amountCents: 8000 });
  });

  it('charges the full period without proration', () => {
    const { lines } = run([assignment({ validFrom: '2026-05-10' })], [plan({ proration: 'none' })]);
    expect(lines[0]!.amountCents).toBe(12000);
  });

  it('marks past periods as catch-up lines (four months back, monthly plan)', () => {
    const { lines } = run([assignment({ validFrom: '2026-02-01' })], [plan({ intervalMonths: 1, amountCents: 1000 })], { until: '2026-06-01' });
    expect(lines.map((l) => l.catchUp)).toEqual([true, true, true, true, false]);
  });

  it('uses the version valid at each period start (fee raise)', () => {
    const { lines } = run([assignment({ validFrom: '2026-01-01' })], [plan(), plan({ validFrom: '2027-01-01', amountCents: 14400 })], { until: '2027-12-31' });
    expect(lines.map((l) => l.amountCents)).toEqual([12000, 14400]);
  });

  it('does not bill days already billed after an interval change (quarterly → monthly from February)', () => {
    const versions = [plan({ intervalMonths: 3, amountCents: 3000 }), plan({ validFrom: '2026-02-01', intervalMonths: 1, amountCents: 1000 })];
    const { lines, skipped } = run([assignment()], versions, { until: '2026-04-30', billed: [{ slot: 'main', start: '2026-01-01', end: '2026-03-31' }] });
    expect(lines.map((l) => l.periodStart)).toEqual(['2026-04-01']);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('bills a one-off exactly once and the admission fee once', () => {
    const v = [plan({ intervalMonths: null, amountCents: 5000, admissionFeeCents: 2500 })];
    const first = run([assignment()], v);
    expect(first.lines.map((l) => [l.kind, l.amountCents])).toEqual([['admission', 2500], ['fee', 5000]]);
    const again = run([assignment()], v, { billed: first.lines.map((l) => ({ slot: l.slot, start: l.periodStart, end: l.periodEnd })) });
    expect(again.lines).toHaveLength(0);
  });

  it('stops at the exit date and uses the override amount', () => {
    const { lines } = run([assignment({ overrideCents: 6000 })], [plan({ intervalMonths: 3, amountCents: 3000 })], { exitDate: '2026-05-31' });
    expect(lines.map((l) => [l.periodStart, l.periodEnd, l.amountCents])).toEqual([['2026-01-01', '2026-03-31', 6000], ['2026-04-01', '2026-05-31', 4000]]);
  });

  it('reports a missing price instead of guessing', () => {
    const { lines, skipped } = run([assignment({ validFrom: '1999-01-01' })], [plan()]);
    expect(lines).toHaveLength(0);
    expect(skipped[0]!.reason).toContain('noch keinen Preis');
  });
});

describe('properties', () => {
  const arbDate = fc.integer({ min: 0, max: 365 * 6 }).map((d) => addDays('2024-01-01', d));

  it('never bills a day twice and every line lies within the assignment, for every interval 1–60 and both anchors', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.constantFrom<'calendar' | 'entry'>('calendar', 'entry'),
        fc.constantFrom<'none' | 'month'>('none', 'month'),
        arbDate,
        fc.option(arbDate, { nil: null }),
        arbDate,
        arbDate,
        (n, anchor, proration, from, to, until1, until2) => {
          const a = assignment({ validFrom: from, validTo: to && to >= from ? to : null });
          const v = [plan({ intervalMonths: n, anchor, proration, validFrom: '2020-01-01' })];
          // Two consecutive runs: the second sees what the first billed.
          const [u1, u2] = until1 < until2 ? [until1, until2] : [until2, until1];
          const r1 = run([a], v, { until: u1, today: '2026-01-01' });
          const billed = r1.lines.map((l) => ({ slot: l.slot, start: l.periodStart, end: l.periodEnd }));
          const r2 = run([a], v, { until: u2, today: '2026-01-01', billed });
          const all = [...billed, ...r2.lines.map((l) => ({ slot: l.slot, start: l.periodStart, end: l.periodEnd }))].sort((x, y) => (x.start < y.start ? -1 : 1));
          for (let i = 1; i < all.length; i++) expect(all[i]!.start > all[i - 1]!.end).toBe(true);
          for (const l of [...r1.lines, ...r2.lines]) {
            expect(l.periodStart >= a.validFrom).toBe(true);
            if (a.validTo) expect(l.periodEnd <= a.validTo).toBe(true);
            expect(l.amountCents).toBeGreaterThanOrEqual(0);
            expect(l.amountCents).toBeLessThanOrEqual(12000);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a split run bills the same total as one run (no gaps, no doubles) for whole-period plans', () => {
    fc.assert(
      fc.property(fc.constantFrom(1, 2, 3, 4, 6, 12), arbDate, arbDate, (n, from, mid) => {
        const a = assignment({ validFrom: `${from.slice(0, 7)}-01` });
        const v = [plan({ intervalMonths: n, proration: 'none', validFrom: '2020-01-01' })];
        const once = run([a], v, { until: '2030-12-31' });
        const part = run([a], v, { until: mid });
        const rest = run([a], v, { until: '2030-12-31', billed: part.lines.map((l) => ({ slot: l.slot, start: l.periodStart, end: l.periodEnd })) });
        const sum = (ls: { amountCents: number }[]) => ls.reduce((s, l) => s + l.amountCents, 0);
        expect(sum(part.lines) + sum(rest.lines)).toBe(sum(once.lines));
      }),
      { numRuns: 300 },
    );
  });
});

describe('review regressions', () => {
  it('bills a one-off main plan after earlier monthly billing', () => {
    const versions = new Map([['p1', [plan({ intervalMonths: 1, amountCents: 1000 })]], ['p2', [plan({ intervalMonths: null, amountCents: 50000 })]]]);
    const monthly = assignment({ validTo: '2026-03-31' });
    const lifetime = assignment({ id: 'a2', planId: 'p2', planName: 'Lebenslang', validFrom: '2026-04-01' });
    const { lines } = run([monthly, lifetime], versions, { until: '2026-04-30', billed: [{ slot: 'main', start: '2026-01-01', end: '2026-03-31', assignmentId: 'a1' }] });
    expect(lines.map((l) => [l.periodStart, l.amountCents])).toEqual([['2026-04-01', 50000]]);
  });

  it('charges the admission fee once even with two assignments of the same plan', () => {
    const v = [plan({ admissionFeeCents: 2500 })];
    const { lines } = run([assignment({ validTo: '2024-12-31', validFrom: '2024-01-01' }), assignment({ id: 'a2', validFrom: '2026-01-01' })], v);
    expect(lines.filter((l) => l.kind === 'admission')).toHaveLength(1);
  });

  it('does not charge the switch month twice at a mid-month plan change', () => {
    const versions = new Map([['p1', [plan({ intervalMonths: 1, amountCents: 1000 })]], ['p2', [plan({ intervalMonths: 12, amountCents: 12000 })]]]);
    const yearly = assignment({ id: 'a2', planId: 'p2', validFrom: '2026-03-16' });
    const { lines } = run([yearly], versions, { billed: [{ slot: 'main', start: '2026-01-01', end: '2026-03-15', assignmentId: 'a1' }] });
    expect(lines[0]!.amountCents).toBe(9000); // April–December
  });
});
