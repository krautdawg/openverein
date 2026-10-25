import { expect, it } from 'vitest';
import { buchungsstapel, pairLines } from './datev.ts';

it('pairs a multi-line entry into account/counter-account rows that add up', () => {
  const rows = pairLines([
    { account: '1200', debitCents: 0, creditCents: 12970, sphere: 'wirtschaft', costCenter: null, isMoney: true },
    { account: '3400', debitCents: 10000, creditCents: 0, sphere: 'wirtschaft', costCenter: 'FEST', isMoney: false },
    { account: '1576', debitCents: 1900, creditCents: 0, sphere: 'wirtschaft', costCenter: 'FEST', isMoney: false },
    { account: '3300', debitCents: 1000, creditCents: 0, sphere: 'wirtschaft', costCenter: null, isMoney: false },
    { account: '1571', debitCents: 70, creditCents: 0, sphere: 'wirtschaft', costCenter: null, isMoney: false },
  ]);
  expect(rows.map((r) => [r.debitAccount, r.creditAccount, r.amountCents, r.costCenter])).toEqual([['3400', '1200', 10000, 'FEST'], ['1576', '1200', 1900, 'FEST'], ['3300', '1200', 1000, null], ['1571', '1200', 70, null]]);
});

it('writes the EXTF 700 header and rows', () => {
  const csv = buchungsstapel({ consultant: 1001, client: 1, fiscalYearStart: '2026-01-01', accountLength: 4, from: '2026-01-01', to: '2026-03-31', createdAt: new Date('2026-04-02T10:11:12.345Z') }, [{ entryNumber: 7, date: '2026-03-05', text: 'Spende "Bäckerei"', debitAccount: '1200', creditAccount: '2250', amountCents: 25000, sphere: 'ideell', costCenter: null }]);
  const [head, cols, row] = csv.split('\r\n');
  expect(head!.startsWith('"EXTF";700;21;"Buchungsstapel";13;20260402101112345;;"OV";"";"";1001;1;20260101;4;20260101;20260331;')).toBe(true);
  expect(cols!.split(';')).toHaveLength(38);
  expect(row).toBe('250,00;"S";"EUR";;;;1200;2250;;0503;"7";;;"Spende ""Bäckerei""";;;;;;;;;;;;;;;;;;;;;;;"1";""');
});

it('finds the fiscal year of a date', async () => {
  const { fiscalYear } = await import('../routes/exports.ts');
  expect(fiscalYear('2026-03-05', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  expect(fiscalYear('2026-03-05', 7)).toEqual({ start: '2025-07-01', end: '2026-06-30' });
  expect(fiscalYear('2026-07-01', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
});
