import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('custom fields: define a select field and fill it for a member', async ({ page }) => {
  await signIn(page);
  await page.goto('/einstellungen/felder');
  await page.getByRole('button', { name: 'Feld hinzufügen' }).click();
  await page.getByLabel('Bezeichnung').fill('Trikotgröße');
  await page.getByLabel('Typ').selectOption({ label: 'Auswahl' });
  await page.getByLabel('Auswahlmöglichkeiten (eine pro Zeile)').fill('S\nM\nL');
  await page.getByRole('button', { name: 'Feld anlegen' }).click();
  await expect(page.getByRole('table', { name: 'Eigene Felder' })).toContainText('{{custom.trikotgroesse}}');

  await page.goto('/mitglieder');
  await expect(page.getByRole('heading', { name: 'Mitglieder', level: 1 })).toBeVisible();
  await page.keyboard.press('n');
  const create = page.getByRole('dialog', { name: 'Mitglied anlegen' });
  await create.getByLabel('Vorname').fill('Toni');
  await create.getByLabel('Nachname').fill('Trikot');
  await create.getByRole('button', { name: 'Anlegen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Trikot, Toni' });
  const section = sheet.getByRole('region', { name: 'Weitere Angaben' });
  await section.getByRole('button', { name: 'Ändern' }).click();
  await section.getByLabel(/Trikotgröße/).selectOption('M');
  await section.getByRole('button', { name: 'Speichern' }).click();
  await expect(section).toContainText('M');
});
