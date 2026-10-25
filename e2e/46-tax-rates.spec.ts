import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('tax rates: the club adds its own rate with an output-tax account', async ({ page }) => {
  await signIn(page);
  await page.goto('/buchhaltung/konten');
  await page.getByRole('button', { name: 'Steuersatz anlegen' }).click();
  const form = page.getByRole('form', { name: 'Neuer Steuersatz' });
  await form.getByLabel('Bezeichnung').fill('Pauschal 5,5 %');
  await form.getByLabel('Satz in %').fill('5,5');
  await form.getByLabel('Gültig ab').fill('2026-01-01');
  await form.getByLabel('Umsatzsteuerkonto').selectOption({ index: 1 });
  await form.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByRole('table', { name: 'Steuersätze' })).toContainText('5,5 %');
});
