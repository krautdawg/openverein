import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('work hours: set the rule, log hours for a member, see what is still open', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Hanna', lastName: 'Helferin', birthDate: '1990-01-01', joinDate: '2020-01-01' } });
  await page.goto('/mitglieder/arbeitsstunden');
  const rule = page.getByRole('form', { name: 'Regel für Arbeitsstunden' });
  await rule.getByLabel('Stunden pro Jahr').fill('8');
  await rule.getByLabel('Ersatzgeld', { exact: true }).fill('12,50');
  await rule.getByRole('button', { name: 'Speichern' }).click();
  await expect(rule.getByRole('status')).toHaveText('Gespeichert.');

  const row = page.getByRole('row', { name: /Helferin, Hanna/ });
  await row.getByRole('button', { name: /Stunden für/ }).click();
  const sheet = page.getByRole('dialog', { name: /Arbeitsstunden \d{4}: Helferin, Hanna/ });
  await sheet.getByLabel('Stunden', { exact: true }).fill('3');
  await sheet.getByLabel('Wofür').fill('Kuchenverkauf');
  await sheet.getByRole('button', { name: 'Eintragen' }).click();
  await expect(sheet.getByRole('list', { name: 'Eingetragene Stunden' })).toContainText('Kuchenverkauf');
  await sheet.getByRole('button', { name: 'Schließen' }).click();
  await expect(row).toContainText('62,50');
});
