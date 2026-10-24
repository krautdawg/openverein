import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('groups and members: create a division, add a member, find and resign them', async ({ page }) => {
  await signIn(page);
  await page.goto('/gruppen');
  await page.getByRole('button', { name: 'Gruppe anlegen' }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Fußball');
  await page.getByLabel('Kürzel').fill('FB');
  await page.getByRole('form', { name: 'Neue Gruppe' }).getByRole('button', { name: 'Gruppe anlegen' }).click();
  await expect(page.getByRole('table', { name: 'Gruppen' })).toContainText('Fußball');

  await page.goto('/mitglieder');
  await expect(page.getByRole('heading', { name: 'Mitglieder', level: 1 })).toBeVisible();
  await page.keyboard.press('n');
  const sheet = page.getByRole('dialog', { name: 'Mitglied anlegen' });
  await sheet.getByLabel('Vorname').fill('Johanna');
  await sheet.getByLabel('Nachname').fill('Musterfrau');
  await sheet.getByLabel('E-Mail').fill('johanna@example.org');
  await sheet.getByLabel('PLZ').fill('12345');
  await sheet.getByLabel('Ort').fill('Musterstadt');
  await sheet.getByLabel('Fußball').check();
  await sheet.getByRole('button', { name: 'Anlegen' }).click();

  const detail = page.getByRole('dialog', { name: 'Musterfrau, Johanna' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Aktiv')).toBeVisible();
  await detail.getByRole('button', { name: 'Schließen' }).click();

  const table = page.getByRole('table', { name: 'Mitglieder' });
  await expect(table).toContainText('Musterfrau, Johanna');
  await expect(table).toContainText('Fußball');

  // Command palette finds the member despite a typo.
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Befehl oder Suche' }).fill('musterfra');
  await page.getByRole('option', { name: /Musterfrau, Johanna/ }).click();
  await expect(detail).toBeVisible();

  await detail.getByRole('button', { name: 'Kündigung erfassen' }).click();
  await detail.getByLabel('Kündigung eingegangen am').fill('2026-05-10');
  await detail.getByLabel('Kündigung eingegangen am').blur();
  await expect(detail.getByLabel('Austritt zum')).toHaveValue('2026-06-30');
  await detail.getByLabel('Austritt zum').fill('2030-12-31');
  await detail.getByRole('button', { name: 'Kündigung speichern' }).click();
  await expect(detail.getByText('Gekündigt')).toBeVisible();
  await expect(detail.getByText('Kündigung erfasst')).toBeVisible();
});
