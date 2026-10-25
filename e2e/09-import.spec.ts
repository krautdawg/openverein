import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('import: easyVerein CSV with dry run, import and rollback', async ({ page }) => {
  await signIn(page);
  await page.goto('/einstellungen/import');
  await page.getByLabel('CSV-Datei').setInputFiles('tests/fixtures/easyverein-members.csv');
  await page.getByRole('button', { name: 'Probelauf' }).click();
  await expect(page.getByRole('table', { name: 'Spaltenzuordnung' })).toBeVisible();
  await expect(page.getByLabel('Ziel für Lieblingsfarbe')).toHaveValue('');
  await expect(page.getByText('IBAN ist ungültig.')).toBeVisible();
  await page.getByRole('button', { name: /Mitglieder importieren/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importiert' })).toBeVisible();
  await page.getByRole('button', { name: 'Zurücknehmen' }).first().click();
  await page.getByRole('button', { name: 'Ja' }).click();
  await expect(page.getByText('zurückgenommen').first()).toBeVisible();
});
