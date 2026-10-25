import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('member lists: the filtered list downloads as PDF and as vCards', async ({ page }) => {
  await signIn(page);
  await page.goto('/mitglieder');
  await page.getByText('Exportieren').click();
  const pdf = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Liste zum Drucken (PDF)' }).click();
  expect((await pdf).suggestedFilename()).toMatch(/^mitglieder-\d{4}-\d{2}-\d{2}\.pdf$/);
  const vcf = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Kontakte (vCard)' }).click();
  expect((await vcf).suggestedFilename()).toMatch(/\.vcf$/);
});
