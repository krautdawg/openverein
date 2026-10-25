import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('overview layout: hide a section and move another, then restore', async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Erste Schritte' })).toBeVisible();
  await page.getByRole('button', { name: 'Übersicht anpassen' }).click();
  await page.getByRole('checkbox', { name: 'Erste Schritte' }).click();
  await expect(page.getByRole('heading', { name: 'Erste Schritte' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Erste Schritte nach oben' }).click();
  await page.getByRole('checkbox', { name: 'Erste Schritte' }).click();
  await expect(page.getByRole('heading', { name: 'Erste Schritte' })).toBeVisible();
  // Restore the default order for the specs after this one.
  await page.request.put('/api/v1/auth/me/overview', { data: { order: [], hidden: [] } });
});
