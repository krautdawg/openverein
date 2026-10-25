import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('honours: a 25-year member is listed and can be greeted by e-mail', async ({ page }) => {
  await signIn(page);
  const year = new Date().getFullYear();
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Hilde', lastName: 'Jubilar', email: 'hilde@example.org', joinDate: `${year - 25}-03-10` } });
  await page.goto('/mitglieder');
  await page.getByRole('link', { name: 'Auswertungen' }).click();
  await page.getByRole('navigation', { name: 'Auswertungen' }).getByRole('link', { name: 'Ehrungen' }).click();
  const list = page.getByRole('list', { name: 'Vereinsjubiläen' });
  await expect(list).toContainText('Jubilar, Hilde');
  await expect(list).toContainText('25 Jahre Mitglied');
  await page.getByRole('button', { name: /E-Mail an alle/ }).first().click();
  await expect(page).toHaveURL(/\/kommunikation$/);
});
