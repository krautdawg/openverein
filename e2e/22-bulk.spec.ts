import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('bulk: select the filtered members, confirm with names, add them to a group', async ({ page }) => {
  await signIn(page);
  const headers = () => ({ 'idempotency-key': randomUUID() });
  await page.request.post('/api/v1/groups', { headers: headers(), data: { name: 'Lauftreff', shortCode: 'LT', kind: 'segment' } });
  for (const lastName of ['Sammel', 'Sammelt']) await page.request.post('/api/v1/members', { headers: headers(), data: { firstName: 'Sina', lastName, joinDate: '2025-01-01' } });

  await page.goto('/mitglieder?q=Sammel');
  await expect(page.getByRole('table', { name: 'Mitglieder' })).toContainText('Sammelt, Sina');
  await page.getByRole('checkbox', { name: 'Alle sichtbaren auswählen' }).check();
  const bar = page.getByRole('form', { name: 'Sammelaktion' });
  await expect(bar).toContainText('2 ausgewählt');
  await bar.getByLabel('Gruppe').selectOption({ label: 'Lauftreff' });
  await bar.getByRole('button', { name: 'Zur Gruppe hinzufügen' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Sammelaktion bestätigen' });
  await expect(confirm).toContainText('Sammel, Sina · Sammelt, Sina');
  await confirm.getByRole('button', { name: 'Ja, ausführen' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 geändert' })).toBeVisible();
});
