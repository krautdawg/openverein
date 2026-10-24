import { expect, it } from 'vitest';
import { parseBankCsv } from './csv.ts';

it('reads a Sparkasse-style CSV export', () => {
  const csv = `"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"BIC (SWIFT-Code)";"Betrag";"Waehrung"
"DE89370400440532013000";"03.11.26";"03.11.26";"GUTSCHR. UEBERWEISUNG";"R-2026-00005 Clara";"Clara Hoffmann";"DE02120300000000202051";"BYLADEM1001";"30,00";"EUR"
"DE89370400440532013000";"04.11.26";"04.11.26";"LASTSCHRIFT";"RUECKLASTSCHRIFT R-2026-00002";"Ben Schulz";"DE75512108001245126199";"";"-123,00";"EUR"
"Kontostand";"";"";"";"";"";"";"";"";""`;
  const { transactions, skipped } = parseBankCsv(csv);
  expect(transactions).toHaveLength(2);
  expect(transactions[0]).toMatchObject({ bookingDate: '2026-11-03', amountCents: 3000, counterpartyName: 'Clara Hoffmann', counterpartyIban: 'DE02120300000000202051', remittance: 'R-2026-00005 Clara' });
  expect(transactions[1]).toMatchObject({ amountCents: -12300, returnReason: 'MS03' });
  expect(skipped).toBe(1);
});

it('reads English-formatted amounts', () => {
  const { transactions } = parseBankCsv('Date,Amount,Purpose\n2026-11-03,"1,234.56",x\n2026-11-03,-12.5,y');
  expect(transactions.map((t) => t.amountCents)).toEqual([123456, -1250]);
});
