import { expect, it } from 'vitest';
import { invoiceNumberRegex, numbersIn } from './matching.ts';

it('finds invoice numbers from the pattern, also when the bank breaks the line', () => {
  const re = invoiceNumberRegex('R-{YYYY}-{seq:5}');
  expect(numbersIn('Beitrag R-2026-00017 Elif', re)).toEqual(['R-2026-00017']);
  expect(numbersIn('BEITRAG R-2026-000 17', re)).toEqual(['R-2026-00017']);
  expect(numbersIn('r-2026-00017', re)).toEqual(['R-2026-00017']);
  expect(numbersIn('R-2026-0001', re)).toEqual([]);
  expect(invoiceNumberRegex('Rg.{seq}').test('Rg.42')).toBe(true);
});
