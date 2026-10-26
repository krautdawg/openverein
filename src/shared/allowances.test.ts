import { describe, expect, it } from 'vitest';
import { allowanceLimit } from './allowances.ts';

describe('allowance limits', () => {
  it('uses the limits of the year', () => {
    expect(allowanceLimit('uebungsleiter', 2025)).toBe(300_000);
    expect(allowanceLimit('uebungsleiter', 2026)).toBe(330_000);
    expect(allowanceLimit('ehrenamt', 2030)).toBe(96_000);
    // 2013-2020: 2,400 / 720 €; earlier years are not supported.
    expect(allowanceLimit('ehrenamt', 2019)).toBe(72_000);
    expect(allowanceLimit('uebungsleiter', 2013)).toBe(240_000);
    expect(allowanceLimit('uebungsleiter', 2021)).toBe(300_000);
    expect(() => allowanceLimit('uebungsleiter', 2012)).toThrow(RangeError);
  });
});
