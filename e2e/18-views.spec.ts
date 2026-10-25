import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('member list: filter by age, save the view, open it again', async ({ page }) => {
  await signIn(page);
  const year = new Date().getFullYear();
  await page.request.post('/api/v1/members', { data: { firstName: 'Fiona', lastName: 'Filterkind', birthDate: `${year - 9}-02-02`, joinDate: '2024-01-01' } });
  await page.goto('/mitglieder');
  await page.getByRole('button', { name: /^Filter/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Filter' });
  await sheet.getByLabel('bis', { exact: true }).first().fill('12');
  await sheet.getByLabel('Name').fill('Kinder bis 12');
  await sheet.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('table', { name: 'Mitglieder' })).toContainText('Filterkind, Fiona');
  await expect(page.getByRole('button', { name: 'Filter (1)' })).toBeVisible();
  await page.goto('/mitglieder');
  await page.getByRole('combobox', { name: 'Gespeicherte Ansicht öffnen' }).selectOption({ label: 'Kinder bis 12' });
  await expect(page).toHaveURL(/alter_bis=12/);
});
