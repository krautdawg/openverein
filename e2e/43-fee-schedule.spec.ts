import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('fee schedule: the treasurer sets up the monthly preview and switches it off again', async ({ page }) => {
  await signIn(page);
  await page.goto('/beitraege/laeufe');
  const form = page.getByRole('form', { name: 'Automatische Vorschau' });
  await form.getByLabel('Tag im Monat').selectOption('3');
  await form.getByLabel('Vorlauf in Tagen').fill('14');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText(/Eingeschaltet: am 3\. jeden Monats, eingerichtet von/)).toBeVisible();
  await form.getByLabel('Tag im Monat').selectOption('');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('region', { name: 'Automatische Vorschau' })).toContainText('Ausgeschaltet.');
});
