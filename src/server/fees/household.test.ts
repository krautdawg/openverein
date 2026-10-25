import { expect, it } from 'vitest';
import { householdDiscount } from './household.ts';

const fam = [
  { memberId: 'a', name: 'Anna', birthDate: '1980-01-01', mainCents: 12000 },
  { memberId: 'b', name: 'Ben', birthDate: '2012-05-01', mainCents: 6000 },
  { memberId: 'c', name: 'Cleo', birthDate: '2015-07-01', mainCents: 6000 },
  { memberId: 'd', name: 'Dora', birthDate: '2018-09-01', mainCents: 6000 },
];

it('applies percent from the n-th member, highest fee first', () => {
  const r = householdDiscount({ kind: 'percent', fromNth: 2, percentBp: 2500, capCents: null }, fam, '2026-01-01');
  expect(r.discountCents).toBe(4500);
  expect(r.perMember).toEqual({ b: 1500, c: 1500, d: 1500 });
  expect(r.label).toBe('Familienrabatt 25 % ab dem 2. Mitglied');
});

it('caps the family total', () => {
  expect(householdDiscount({ kind: 'cap', fromNth: null, percentBp: null, capCents: 20000 }, fam, '2026-01-01')).toMatchObject({ discountCents: 10000, perMember: { b: 6000, c: 4000 } });
  expect(householdDiscount({ kind: 'cap', fromNth: null, percentBp: null, capCents: 50000 }, fam, '2026-01-01').discountCents).toBe(0);
});

it('makes children free from the n-th child, oldest first, by age on the date', () => {
  expect(householdDiscount({ kind: 'children_free', fromNth: 3, percentBp: null, capCents: null }, fam, '2026-01-01').perMember).toEqual({ d: 6000 });
  // Ben turns 18 on 2030-05-01: then Cleo and Dora are the first two children.
  expect(householdDiscount({ kind: 'children_free', fromNth: 2, percentBp: null, capCents: null }, fam, '2030-06-01').perMember).toEqual({ d: 6000 });
});
