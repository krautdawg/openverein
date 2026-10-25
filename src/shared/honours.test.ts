import { describe, expect, it } from 'vitest';
import { isHonouredAnniversary, isRoundBirthday, sameDay } from './honours.ts';

describe('honours', () => {
  it('knows the honoured anniversaries and round birthdays', () => {
    expect([5, 10, 12, 15, 25, 40].filter(isHonouredAnniversary)).toEqual([10, 15, 25, 40]);
    expect([17, 18, 20, 30, 65, 66, 100, 101].filter(isRoundBirthday)).toEqual([18, 30, 65, 100, 101]);
  });
  it('moves 29 February to the 28th outside leap years', () => {
    expect(sameDay('2000-02-29', 2026)).toBe('2026-02-28');
    expect(sameDay('2000-02-29', 2028)).toBe('2028-02-29');
    expect(sameDay('1990-07-04', 2026)).toBe('2026-07-04');
  });
});
