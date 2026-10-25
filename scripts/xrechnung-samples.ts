// Writes sample XRechnung files covering our cases (mixed rates with rounding, small business, credit note,
// direct debit with a household discount, tax number only). CI validates them with the KoSIT validator.
import { mkdirSync, writeFileSync } from 'node:fs';
import { xrechnungCii, type XInvoice } from '../src/server/invoices/xrechnung.ts';

const out = process.argv[2] ?? 'xrechnung-samples';
mkdirSync(out, { recursive: true });
const base: Omit<XInvoice, 'lines'> = {
  number: 'R-2026-00042', typeCode: '380', issueDate: '2026-02-01', dueDate: '2026-02-15', precedingNumber: null, note: 'Beiträge 2026',
  seller: { name: 'SV Lindenhof 1921 e.V.', street: 'Am Sportplatz 1', postalCode: '12345', city: 'Lindenhof', country: 'DE', vatId: 'DE123456789', taxNumber: '12/345/67890', registerNumber: 'VR 1234', contactName: 'Erika Mustermann', contactPhone: '+49 30 1234567', contactEmail: 'kasse@sv-lindenhof.example', smallBusiness: false },
  buyer: { name: 'Stadt Lindenhof', street: 'Rathausplatz 1', postalCode: '12345', city: 'Lindenhof', country: 'DE', reference: '04011000-12345-67', address: 'rechnung@lindenhof.example', vatId: null },
  payment: { kind: 'transfer', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', accountName: 'SV Lindenhof 1921 e.V.' },
};
const line = (text: string, grossCents: number, ratePct: number, quantity = 1, periodStart: string | null = null, periodEnd: string | null = null) => ({ text, quantity, grossCents, ratePct, periodStart, periodEnd });
const samples: Record<string, XInvoice> = {
  'mixed-rates': { ...base, lines: [line('Hallennutzung Januar', 11900, 19, 1, '2026-01-01', '2026-01-31'), line('Getränke', 1070, 7, 3), line('Mitgliedsbeitrag 2026', 12000, 0, 1, '2026-01-01', '2026-12-31'), line('Rundungsfall', 1001, 19)] },
  'small-business': { ...base, number: 'R-2026-00043', seller: { ...base.seller, smallBusiness: true, vatId: null }, lines: [line('Kursgebühr', 5000, 19)] },
  'credit-note': { ...base, number: 'S-2026-00001', typeCode: '381', precedingNumber: 'R-2026-00042', lines: [line('Storno Hallennutzung', 11900, 19)] },
  'direct-debit-discount': { ...base, number: 'R-2026-00044', payment: { kind: 'direct_debit', mandateReference: 'M-0001', creditorId: 'DE98ZZZ09999999999', debtorIban: 'DE02120300000000202051' }, lines: [line('Mitgliedsbeitrag', 6000, 0, 1, '2026-01-01', '2026-12-31'), line('Familienrabatt', -1500, 0)] },
  'tax-number-only': { ...base, number: 'R-2026-00045', seller: { ...base.seller, vatId: null }, lines: [line('Mitgliedsbeitrag', 6000, 0), line('Trikot', 5950, 19, 2)] },
};
for (const [name, x] of Object.entries(samples)) writeFileSync(`${out}/${name}.xml`, xrechnungCii(x));
console.log(`${Object.keys(samples).length} samples in ${out}`);
