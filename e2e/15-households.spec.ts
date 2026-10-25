import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('households: create a household from two members and set a family discount', async ({ page }) => {
  await signIn(page);
  for (const first of ['Hanna', 'Henri']) {
    await page.request.post('/api/v1/members', { data: { firstName: first, lastName: 'Haushalt', joinDate: '2024-01-01' } });
  }
  await page.goto('/mitglieder');
  await page.getByRole('link', { name: 'Haushalte' }).click();
  await page.getByRole('button', { name: 'Haushalt anlegen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Haushalt anlegen' });
  await sheet.getByLabel('Name').fill('Familie Haushalt');
  for (const first of ['Hanna', 'Henri']) {
    await sheet.getByLabel('Mitglied hinzufügen').fill(first);
    await sheet.getByRole('button', { name: `Haushalt, ${first} wählen` }).click();
  }
  await sheet.getByRole('button', { name: 'Anlegen' }).click();
  const detail = page.getByRole('dialog', { name: 'Familie Haushalt' });
  await expect(detail).toContainText('Es zahlt Hanna Haushalt');
  await detail.getByRole('button', { name: 'Regel speichern' }).click();
  await expect(detail.getByRole('region', { name: 'Familienrabatt' })).toContainText('Familienrabatt 25 % ab dem 2. Mitglied');
});
