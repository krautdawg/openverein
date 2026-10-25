import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('receipts: record a paid receipt with a file, see it in the cash book', async ({ page }) => {
  await signIn(page);
  // Cash first, so the expense from the cash box is allowed.
  const accounts = await (await page.request.get('/api/v1/ledger/accounts')).json();
  const id = (n: string) => accounts.find((a: { number: string }) => a.number === n).id;
  await page.request.post('/api/v1/ledger/bookings', { data: { kind: 'income', date: new Date().toISOString().slice(0, 10), text: 'Kasse Startgeld', moneyAccountId: id('1000'), lines: [{ grossCents: 10000, accountId: id('4400') }] }, headers: { 'idempotency-key': crypto.randomUUID() } });

  await page.goto('/buchhaltung/belege');
  await page.getByRole('button', { name: 'Beleg erfassen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Beleg erfassen' });
  await sheet.locator('input[type=file]').setInputFiles({ name: 'baelle.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Bälle') });
  await expect(sheet).toContainText('baelle.pdf');
  await sheet.getByLabel('Von (Lieferant)').fill('Sporthaus Lindner');
  await sheet.getByLabel('Betrag brutto').fill('35,90');
  await sheet.getByLabel('Ausgabenkonto').selectOption({ label: '6100 Sportbetrieb und Material' });
  await sheet.getByLabel('Schon bezahlt (wird dann gleich gebucht)').check();
  await sheet.getByLabel('Bezahlt von').selectOption({ label: '1000 Kasse' });
  await sheet.getByRole('button', { name: 'Speichern' }).click();
  await page.getByRole('button', { name: 'bezahlt', exact: true }).click();
  await expect(page.getByRole('row', { name: /Sporthaus Lindner/ })).toContainText('35,90');

  await page.getByRole('link', { name: 'Kassenbuch' }).click();
  await page.getByRole('combobox').first().selectOption({ label: '1000 Kasse' });
  await expect(page.getByRole('table', { name: 'Kassenbuch' })).toContainText('Sporthaus Lindner');
  await expect(page.getByRole('table', { name: 'Kassenbuch' })).toContainText('64,10');
});
