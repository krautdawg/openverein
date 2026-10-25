import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('privacy: consent in the member sheet, withdrawal, access export, retention page', async ({ page }) => {
  await signIn(page);
  await page.goto('/mitglieder');
  await expect(page.getByRole('heading', { name: 'Mitglieder', level: 1 })).toBeVisible();
  await page.keyboard.press('n');
  const create = page.getByRole('dialog', { name: 'Mitglied anlegen' });
  await create.getByLabel('Vorname').fill('Dora');
  await create.getByLabel('Nachname').fill('Datenschutz');
  await create.getByRole('button', { name: 'Anlegen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Datenschutz, Dora' });
  await sheet.getByRole('button', { name: 'Einwilligung erfassen' }).click();
  await sheet.getByLabel('Wofür').selectOption({ label: 'Fotos auf Website und in sozialen Medien' });
  await sheet.getByRole('button', { name: 'Erfassen', exact: true }).click();
  await expect(sheet.getByRole('list', { name: 'Einwilligungen' })).toContainText('Fotos auf Website');
  await sheet.getByRole('button', { name: /Einwilligung Fotos .* widerrufen/ }).click();
  await expect(sheet.getByRole('list', { name: 'Einwilligungen' })).toContainText('widerrufen am');
  const download = page.waitForEvent('download');
  await sheet.getByRole('link', { name: 'Auskunft (Art. 15)' }).click();
  expect((await download).suggestedFilename()).toMatch(/^Auskunft-.*\.zip$/);
  await page.goto('/einstellungen/datenschutz');
  await expect(page.getByRole('table', { name: 'Aufbewahrungsfristen' })).toContainText('§ 147');
});
