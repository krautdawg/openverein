import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { xrechnungCii } from '../invoices/xrechnung.ts';
import { readEinvoice } from './einvoice.ts';

const cii = xrechnungCii({
  number: 'R-2026-00042', typeCode: '380', issueDate: '2026-02-01', dueDate: '2026-02-15', precedingNumber: null, note: null,
  seller: { name: 'Sporthallen GmbH', street: 'Weg 1', postalCode: '12345', city: 'Ort', country: 'DE', vatId: 'DE123456789', taxNumber: null, registerNumber: null, contactName: 'A', contactPhone: '1', contactEmail: 'a@example.org', smallBusiness: false },
  buyer: { name: 'SV Lindenhof', street: 'Platz 1', postalCode: '12345', city: 'Ort', country: 'DE', reference: 'x', address: 'b@example.org', vatId: null },
  payment: { kind: 'transfer', iban: 'DE89370400440532013000', bic: null, accountName: 'Sporthallen GmbH' },
  lines: [{ text: 'Hallenmiete', quantity: 1, grossCents: 11900, ratePct: 19, periodStart: null, periodEnd: null }, { text: 'Getränke', quantity: 1, grossCents: 1070, ratePct: 7, periodStart: null, periodEnd: null }],
});

const ubl = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>INV-7</cbc:ID><cbc:IssueDate>2026-03-05</cbc:IssueDate><cbc:DueDate>2026-03-19</cbc:DueDate>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Ballshop</cbc:Name></cac:PartyName><cac:PartyLegalEntity><cbc:RegistrationName>Ballshop GmbH</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal>
</Invoice>`;

describe('incoming e-invoices', () => {
  it('reads XRechnung CII with gross per VAT rate', async () => {
    const s = await readEinvoice(Buffer.from(cii));
    expect(s).toMatchObject({ format: 'cii', supplier: 'Sporthallen GmbH', number: 'R-2026-00042', receiptDate: '2026-02-01', dueDate: '2026-02-15', totalCents: 12970 });
    expect(s!.groups.sort((a, b) => b.ratePct - a.ratePct)).toEqual([{ ratePct: 19, grossCents: 11900 }, { ratePct: 7, grossCents: 1070 }]);
  });

  it('reads UBL', async () => {
    expect(await readEinvoice(Buffer.from(ubl))).toEqual({ format: 'ubl', supplier: 'Ballshop GmbH', number: 'INV-7', receiptDate: '2026-03-05', dueDate: '2026-03-19', totalCents: 11900, groups: [{ ratePct: 19, grossCents: 11900 }], unsupported: null });
  });

  it('suggests no amounts for credit notes and foreign currencies', async () => {
    const credit = await readEinvoice(Buffer.from(ubl.replace('<Invoice ', '<CreditNote ').replace('</Invoice>', '</CreditNote>').replace('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2', 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2')));
    expect(credit).toMatchObject({ totalCents: null, groups: [], unsupported: expect.stringContaining('Gutschrift') });
    const ciiCredit = await readEinvoice(Buffer.from(cii.replace('<ram:TypeCode>380</ram:TypeCode>', '<ram:TypeCode>381</ram:TypeCode>')));
    expect(ciiCredit?.unsupported).toContain('Gutschrift');
    const usd = await readEinvoice(Buffer.from(ubl.replaceAll('currencyID="EUR"', 'currencyID="USD"')));
    expect(usd).toMatchObject({ totalCents: null, unsupported: expect.stringContaining('USD') });
  });

  it('finds the XML inside a ZUGFeRD PDF and ignores other files', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await pdf.attach(Buffer.from(cii), 'factur-x.xml', { mimeType: 'text/xml' });
    expect((await readEinvoice(Buffer.from(await pdf.save())))?.number).toBe('R-2026-00042');
    expect(await readEinvoice(Buffer.from('%PDF-1.4 nothing'))).toBeNull();
    expect(await readEinvoice(Buffer.from('<!DOCTYPE x [<!ENTITY a "b">]><Invoice/>'))).toBeNull();
    expect(await readEinvoice(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
