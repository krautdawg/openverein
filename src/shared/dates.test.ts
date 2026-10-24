import { describe, expect, it } from 'vitest';
import { periodEnd, proposeExitDate, todayIn } from './dates.ts';

describe('proposeExitDate', () => {
  it('end of quarter with 6 weeks notice (spec scenario)', () => {
    expect(proposeExitDate('2026-05-10', 6, 'quarter_end')).toBe('2026-06-30');
  });
  it('rolls into the next quarter when the notice is too late', () => {
    expect(proposeExitDate('2026-05-25', 6, 'quarter_end')).toBe('2026-09-30');
  });
  it('handles year end and leap years', () => {
    expect(proposeExitDate('2027-11-30', 6, 'year_end')).toBe('2028-12-31');
    expect(periodEnd('2028-02-10', 1)).toBe('2028-02-29');
    expect(proposeExitDate('2026-01-01', 0, 'any_day')).toBe('2026-01-01');
  });
});

describe('todayIn', () => {
  it('uses the business time zone, not UTC', () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Berlin.
    expect(todayIn('Europe/Berlin', new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });
});
