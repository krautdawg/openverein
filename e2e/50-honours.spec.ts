import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('honours: an anniversary is honoured and recorded for the year', async ({ page }) => {
  await signIn(page);
  const year = new Date().getFullYear();
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Hanna', lastName: 'Treue', joinDate: `${year - 25}-03-01` } });
  await page.goto(`/mitglieder/ehrungen?jahr=${year}`);
  await page.getByRole('list', { name: 'Vereinsjubiläen' }).getByRole('listitem').filter({ hasText: 'Treue' }).getByRole('button', { name: 'Ehrung eintragen' }).click();
  const form = page.getByRole('form', { name: 'Ehrung eintragen' });
  await expect(form.getByLabel('Ehrung')).toHaveValue('Ehrennadel 25 Jahre');
  await form.getByRole('button', { name: 'Eintragen' }).click();
  await expect(page.getByRole('list', { name: `Verliehen ${year}` })).toContainText('Ehrennadel 25 Jahre');
});
