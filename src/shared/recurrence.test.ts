import { describe, expect, it } from 'vitest';
import { formatRule, occurrences, parseRule } from './recurrence.ts';

describe('recurrence', () => {
  it('weekly on two days with an exception (24 Dec)', () => {
    const dates = occurrences('2026-12-01', 'FREQ=WEEKLY;BYDAY=TU,TH', '2026-12-01', '2026-12-31', ['2026-12-24']);
    expect(dates).toEqual(['2026-12-01', '2026-12-03', '2026-12-08', '2026-12-10', '2026-12-15', '2026-12-17', '2026-12-22', '2026-12-29', '2026-12-31']);
  });
  it('every second week until a date', () => {
    expect(occurrences('2026-03-02', 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20260401', '2026-01-01', '2026-12-31')).toEqual(['2026-03-02', '2026-03-16', '2026-03-30']);
  });
  it('count includes occurrences before the window', () => {
    expect(occurrences('2026-01-05', 'FREQ=WEEKLY;COUNT=3', '2026-01-10', '2026-12-31')).toEqual(['2026-01-12', '2026-01-19']);
  });
  it('monthly on the 31st skips short months', () => {
    expect(occurrences('2026-01-31', 'FREQ=MONTHLY;COUNT=4', '2026-01-01', '2026-12-31')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  });
  it('daily and single events', () => {
    expect(occurrences('2026-05-01', 'FREQ=DAILY;COUNT=3', '2026-05-01', '2026-05-31')).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    expect(occurrences('2026-05-01', null, '2026-05-01', '2026-05-31')).toEqual(['2026-05-01']);
  });
  it('round-trips and rejects what it cannot do', () => {
    expect(formatRule(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=20261231'))).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=20261231');
    expect(() => parseRule('FREQ=YEARLY')).toThrow();
  });
});
