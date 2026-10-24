import { describe, expect, it } from 'vitest';
import { isValidCreditorId } from '../../shared/iban.ts';
import { addBusinessDays, isTargetDay, pain001, pain008, sepaText, splitIntoFiles } from './pain.ts';
import { validateSepa } from './validate.ts';

const creditor = { name: 'TSV Müßtadt 1890 e.V.', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' };
const item = (n: number, amountCents = 12000) => ({ endToEndId: `OV-E2E-${n}`, amountCents, mandateId: `M-${n}`, mandateSignedOn: '2024-01-15', debtorName: 'Jörg Yılmaz & Söhne', debtorIban: 'DE02120300000000202051', debtorBic: n % 2 ? null : 'BYLADEM1001', remittance: `Mitgliedsbeitrag 2026 R-2026-${n} – Danke!` });

describe('pain files', () => {
  it('pain.008.001.08 passes the official XSD, with and without BIC', () => {
    const xml = pain008({ messageId: 'OV-20261024-0001', createdAt: '2026-10-24T10:00:00', creditor, creditorId: 'DE98ZZZ09999999999', collectionDate: '2026-11-02', sequenceType: 'RCUR', batchBooking: true, items: [item(1), item(2, 1550)] });
    expect(() => validateSepa(xml, 'pain.008.001.08')).not.toThrow();
    expect(xml).toContain('<CtrlSum>135.50</CtrlSum>');
    expect(xml).toContain('Joerg Yilmaz + Soehne');
  });

  it('marks mandate amendments after an IBAN change (same bank: old account, new bank: SMNDA)', () => {
    const sameBank = { ...item(3), originalIban: 'DE02120300000000202052'.slice(0, 22) };
    const newBank = { ...item(4), originalIban: 'DE89370400440532013000' };
    const xml = pain008({ messageId: 'OV-1', createdAt: '2026-10-24T10:00:00', creditor, creditorId: 'DE98ZZZ09999999999', collectionDate: '2026-11-02', sequenceType: 'RCUR', batchBooking: true, items: [sameBank, newBank] });
    expect(() => validateSepa(xml, 'pain.008.001.08')).not.toThrow();
    expect(xml).toContain('<AmdmntInd>true</AmdmntInd><AmdmntInfDtls><OrgnlDbtrAcct><Id><IBAN>DE02120300000000202052</IBAN>');
    expect(xml).toContain('<Othr><Id>SMNDA</Id></Othr>');
  });

  it('pain.001.001.09 passes the official XSD', () => {
    const xml = pain001({ messageId: 'OV-T-1', createdAt: '2026-10-24T10:00:00', debtor: creditor, executionDate: '2026-10-26', batchBooking: true, items: [{ endToEndId: 'OV-T-1-1', amountCents: 2500, creditorName: 'Eva Erstattung', creditorIban: 'DE02120300000000202051', creditorBic: null, remittance: 'Gutschrift G-1' }] });
    expect(() => validateSepa(xml, 'pain.001.001.09')).not.toThrow();
  });

  it('rejects an invalid file', () => {
    const xml = pain008({ messageId: 'x'.repeat(40), createdAt: '2026-10-24T10:00:00', creditor, creditorId: 'DE98ZZZ09999999999', collectionDate: '2026-11-02', sequenceType: 'RCUR', batchBooking: true, items: [item(1)] });
    expect(() => validateSepa(xml, 'pain.008.001.08')).toThrow();
  });

  it('restricts text to the SEPA character set', () => {
    expect(sepaText('Grüße <script> € 100%', 140)).toBe('Gruesse script 100');
  });

  it('splits by 999 items and by order limit', () => {
    const items = Array.from({ length: 2000 }, () => ({ amountCents: 100 }));
    expect(splitIntoFiles(items, null).map((f) => f.length)).toEqual([999, 999, 2]);
    expect(splitIntoFiles([{ amountCents: 600 }, { amountCents: 500 }, { amountCents: 400 }], 1000).map((f) => f.length)).toEqual([1, 2]);
    expect(() => splitIntoFiles([{ amountCents: 2000 }], 1000)).toThrow();
  });

  it('validates creditor IDs and TARGET2 days', () => {
    expect(isValidCreditorId('DE98ZZZ09999999999')).toBe(true);
    expect(isValidCreditorId('DE99ZZZ09999999999')).toBe(false);
    expect(isTargetDay('2026-04-03')).toBe(false); // Good Friday
    expect(isTargetDay('2026-04-06')).toBe(false); // Easter Monday
    expect(isTargetDay('2026-12-24')).toBe(true);
    expect(addBusinessDays('2026-12-23', 2)).toBe('2026-12-28');
  });
});
