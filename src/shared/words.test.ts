import { expect, it } from 'vitest';
import { euroInWords, numberInWords } from './words.ts';

it('writes German numbers in words', () => {
  expect(numberInWords(1)).toBe('eins');
  expect(numberInWords(21)).toBe('einundzwanzig');
  expect(numberInWords(101)).toBe('einhunderteins');
  expect(numberInWords(250)).toBe('zweihundertfünfzig');
  expect(numberInWords(1250)).toBe('eintausendzweihundertfünfzig');
  expect(numberInWords(17_000)).toBe('siebzehntausend');
  expect(numberInWords(1_000_001)).toBe('einemillioneins');
  expect(euroInWords(1250)).toBe('zwölf Euro und fünfzig Cent');
  expect(euroInWords(30000)).toBe('dreihundert Euro');
});
