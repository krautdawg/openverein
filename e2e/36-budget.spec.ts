import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('budget: plan an expense account and save it', async ({ page }) => {
  await signIn(page);
  await page.goto('/buchhaltung/haushaltsplan');
  const expenses = page.getByRole('table', { name: 'Ausgaben' });
  const input = expenses.getByRole('textbox').first();
  await input.fill('1.500,00');
  await page.getByRole('button', { name: 'Plan speichern' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gespeichert.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('table', { name: 'Ausgaben' }).getByRole('textbox').first()).toHaveValue('1500,00');
});
