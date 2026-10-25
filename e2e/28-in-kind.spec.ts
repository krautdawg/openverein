import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('in-kind donation: record goods with value and origin, confirm on the Sachzuwendung template', async ({ page }) => {
  await signIn(page);
  await page.goto('/spenden');
  await page.getByRole('button', { name: 'Spende erfassen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Spende erfassen' });
  await sheet.getByRole('button', { name: /Neu: Name/ }).click();
  await sheet.getByLabel('Vorname').fill('Sabine');
  await sheet.getByLabel('Nachname').fill('Sachlich');
  await sheet.getByLabel('Straße und Hausnummer').fill('Lagerweg 2');
  await sheet.getByLabel('PLZ').fill('12345');
  await sheet.getByLabel('Ort').fill('Musterstadt');
  await sheet.getByRole('button', { name: 'Sache' }).click();
  await sheet.getByLabel('Wert', { exact: true }).fill('180,00');
  await sheet.getByLabel(/Genaue Bezeichnung/).fill('Sechs Trainingsleibchen, neu, Kaufpreis 180 €');
  await sheet.getByLabel(/Unterlagen zur Wertermittlung/).check();
  await sheet.getByRole('button', { name: 'Erfassen' }).click();
  const row = page.getByRole('row', { name: /Sabine Sachlich/ });
  await expect(row).toContainText('Sachspende');
  await row.getByRole('button', { name: /bestätigen$/ }).click();
  await expect(row.getByRole('link', { name: /^ZB-\d{4}-\d{4}$/ })).toBeVisible();
});
