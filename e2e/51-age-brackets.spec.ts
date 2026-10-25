import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('age brackets: a fee plan with a lower amount for children', async ({ page }) => {
  await signIn(page);
  await page.goto('/beitraege');
  await page.getByRole('button', { name: 'Beitragsart anlegen' }).click();
  const form = page.getByRole('form', { name: 'Neue Beitragsart' });
  await form.getByLabel('Name').fill('Familienbeitrag nach Alter');
  await form.getByLabel('Betrag je Zeitraum').fill('120,00');
  await form.getByLabel('Gültig ab').fill('2025-01-01');
  await form.getByRole('button', { name: 'Altersstufe hinzufügen' }).click();
  await form.getByLabel('Altersstufe 1: bis Alter').fill('17');
  await form.getByLabel('Altersstufe 1: Betrag in Euro').fill('60,00');
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/fee-plans') && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Anlegen' }).click();
  expect((await (await created).json()).current.ageBrackets).toEqual([{ upToAge: 17, amountCents: 6000 }]);
});
