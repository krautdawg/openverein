import { expect, test } from '@playwright/test';
import { xrechnungCii } from '../src/server/invoices/xrechnung.ts';
import { signIn } from './helpers.ts';

const xml = xrechnungCii({
  number: 'HM-2026-117', typeCode: '380', issueDate: '2026-02-01', dueDate: '2026-02-20', precedingNumber: null, note: null,
  seller: { name: 'Hallen Lindenhof GmbH', street: 'Weg 1', postalCode: '12345', city: 'Ort', country: 'DE', vatId: 'DE123456789', taxNumber: null, registerNumber: null, contactName: 'A', contactPhone: '1', contactEmail: 'a@example.org', smallBusiness: false },
  buyer: { name: 'TSV', street: 'Platz 1', postalCode: '12345', city: 'Ort', country: 'DE', reference: 'x', address: 'b@example.org', vatId: null },
  payment: { kind: 'transfer', iban: 'DE89370400440532013000', bic: null, accountName: 'Hallen Lindenhof GmbH' },
  lines: [{ text: 'Hallenmiete Februar', quantity: 1, grossCents: 23800, ratePct: 19, periodStart: null, periodEnd: null }],
});

test('incoming e-invoice: an XRechnung upload fills in the receipt', async ({ page }) => {
  await signIn(page);
  await page.goto('/buchhaltung/belege');
  await page.getByRole('button', { name: 'Beleg erfassen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Beleg erfassen' });
  await sheet.locator('input[type=file]').setInputFiles({ name: 'rechnung.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(sheet.getByRole('status').filter({ hasText: 'E-Rechnung erkannt' })).toBeVisible();
  await expect(sheet.getByLabel('Von (Lieferant)')).toHaveValue('Hallen Lindenhof GmbH');
  await expect(sheet.getByLabel('Rechnungsnummer')).toHaveValue('HM-2026-117');
  await expect(sheet.getByLabel('Betrag brutto')).toHaveValue('238,00');
  await expect(sheet.getByLabel('Fällig am (optional)')).toHaveValue('2026-02-20');
});
