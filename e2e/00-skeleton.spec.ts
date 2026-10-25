import { expect, test } from '@playwright/test';
import { codeAt, currentStep } from '../src/server/auth/totp.ts';
import { saveAdmin } from './helpers.ts';

test('first run: set up the club, use the command palette, rename the club, log out and back in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Verein einrichten' })).toBeVisible();
  await page.getByLabel('Name des Vereins').fill('TSV Musterstadt 1890 e.V.');
  await page.getByLabel('Dein Name').fill('Erika Mustermann');
  await page.getByLabel('E-Mail').fill('erika@example.org');
  await page.getByLabel('Passwort').fill('korrekt-pferd-batterie');
  await page.getByRole('button', { name: 'Verein anlegen' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Erika');

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Befehl oder Suche' }).fill('einst');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /TSV Musterstadt.*bearbeiten/ }).click();
  await page.getByLabel('Name des Vereins').fill('SV Blau-Weiß 1921 e.V.');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /SV Blau-Weiß.*bearbeiten/ })).toBeVisible();
  await expect(page.locator('.rail-club')).toContainText('SV Blau-Weiß');

  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
  await page.getByLabel('E-Mail').fill('erika@example.org');
  await page.getByLabel('Passwort').fill('korrekt-pferd-batterie');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Erika');

  // Admins hold finance rights: the banner asks for the second factor until it is set up.
  await expect(page.getByRole('note').filter({ hasText: 'zweitem Faktor' })).toBeVisible();
  await page.getByRole('link', { name: 'Jetzt einrichten' }).click();
  await page.getByRole('button', { name: 'Jetzt einrichten' }).click();
  const secret = (await page.locator('code.token-once').innerText()).replace(/\s+/g, '');
  await page.getByLabel('2. Code aus der App').fill(codeAt(secret, currentStep()));
  await page.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(page.getByText('Wiederherstellungscodes')).toBeVisible();
  await expect(page.locator('.recovery-codes li')).toHaveCount(10);
  saveAdmin({ secret, cookies: (await page.context().cookies()).filter((c) => c.name === 'ov_session') });
});
