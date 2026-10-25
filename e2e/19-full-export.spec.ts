import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('full export: an admin starts the export as a background job and downloads it', async ({ page }) => {
  await signIn(page);
  await page.goto('/einstellungen/export');
  await page.getByRole('button', { name: 'Gesamtexport erstellen' }).click();
  // The job tray follows the job to the end.
  const tray = page.getByRole('complementary', { name: 'Hintergrundaufgaben' });
  await expect(tray).toContainText('Gesamtexport');
  await expect(tray).toContainText('Fertig', { timeout: 20_000 });
  await expect(tray.getByRole('link', { name: 'Ergebnis ansehen' })).toBeVisible();
  const item = page.getByRole('list', { name: 'Exporte' }).getByRole('listitem').first();
  await expect(item).toContainText('SHA-256');
  const download = page.waitForEvent('download');
  await item.getByRole('button', { name: 'Herunterladen' }).click();
  expect((await download).suggestedFilename()).toMatch(/^OpenVerein-Export-\d{4}-\d{2}-\d{2}\.zip$/);
});
