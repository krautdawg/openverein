import { expect, it } from 'vitest';
import { isValidBic, isValidIban } from './iban.ts';

it('validates IBANs with mod-97', () => {
  expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
  expect(isValidIban('DE89370400440532013001')).toBe(false);
  expect(isValidIban('AT611904300234573201')).toBe(true);
  expect(isValidIban('DE8937040044053201300')).toBe(false);
  expect(isValidBic('COBADEFFXXX')).toBe(true);
  expect(isValidBic('COBADE')).toBe(false);
});
