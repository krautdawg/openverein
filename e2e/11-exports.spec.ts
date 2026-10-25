import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('exports: DATEV settings, mapping hint, tax-audit package download', async ({ page }) => {
  await signIn(page);
  await page.goto('/buchhaltung/export');
  await page.getByLabel('Beraternummer').fill('1001');
  await page.getByLabel('Mandantennummer').fill('1');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await page.getByRole('button', { name: 'Alles im Zeitraum' }).click();
  await page.getByRole('button', { name: 'Exportieren' }).click();
  // Earlier flows booked entries on accounts without DATEV numbers: the export names them and links the chart.
  await expect(page.getByRole('alert')).toContainText(/DATEV-Kontonummern|keine/);
  const year = new Date().getFullYear();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: `Paket ${year}` }).click();
  expect((await download).suggestedFilename()).toBe(`GoBD_Z3_${year}.zip`);
});
