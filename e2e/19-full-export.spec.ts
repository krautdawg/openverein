import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('full export: an admin creates and downloads the club export', async ({ page }) => {
  await signIn(page);
  await page.goto('/einstellungen/export');
  await page.getByRole('button', { name: 'Gesamtexport erstellen' }).click();
  const item = page.getByRole('list', { name: 'Exporte' }).getByRole('listitem').first();
  await expect(item).toContainText('SHA-256');
  const download = page.waitForEvent('download');
  await item.getByRole('button', { name: 'Herunterladen' }).click();
  expect((await download).suggestedFilename()).toMatch(/^OpenVerein-Export-\d{4}-\d{2}-\d{2}\.zip$/);
});
