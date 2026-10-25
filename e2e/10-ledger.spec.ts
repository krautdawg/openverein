import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('ledger: book a donation, see it in the journal and the EÜR, reverse it', async ({ page }) => {
  await signIn(page);
  await page.goto('/buchhaltung');
  await page.getByRole('button', { name: 'Buchen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Buchen' });
  await sheet.getByLabel('Buchungstext').fill('Spende Bäckerei Krause');
  await sheet.getByLabel('Eingegangen auf').selectOption({ label: '1100 Bank' });
  await sheet.getByLabel('Betrag brutto').fill('250,00');
  await sheet.getByLabel('Einnahmenkonto').selectOption({ label: '4100 Spenden' });
  await sheet.getByRole('button', { name: 'Buchen', exact: true }).click();
  const row = page.getByRole('row', { name: /Spende Bäckerei Krause/ });
  await expect(row).toContainText('250,00');

  await page.getByRole('link', { name: 'EÜR' }).click();
  await expect(page.getByRole('table', { name: 'Ergebnis nach Konten' })).toContainText('Spenden');

  await page.getByRole('link', { name: 'Journal' }).click();
  await page.getByRole('row', { name: /Spende Bäckerei Krause/ }).click();
  await page.getByRole('button', { name: 'Stornieren …' }).click();
  await page.getByRole('button', { name: 'Ja, stornieren' }).click();
  await expect(page.getByRole('row', { name: /Storno Nr\./ }).first()).toBeVisible();
});
