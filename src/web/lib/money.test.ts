import { expect, it } from 'vitest';
import { parseEuro } from './money.ts';

it('parses German and plain amounts to cents', () => {
  expect(parseEuro('12,50')).toBe(1250);
  expect(parseEuro('1.234,5')).toBe(123450);
  expect(parseEuro('120')).toBe(12000);
  expect(parseEuro('12.5')).toBe(1250);
  expect(parseEuro('12,505')).toBeNull();
  expect(parseEuro('abc')).toBeNull();
});
