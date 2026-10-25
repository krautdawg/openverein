import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('contact log: a call is noted on the member record', async ({ page }) => {
  await signIn(page);
  const m = await (await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Klara', lastName: 'Kontakt', joinDate: '2024-01-01' } })).json();
  await page.goto(`/mitglieder/${m.id}`);
  await page.getByRole('button', { name: 'Kontakt eintragen' }).click();
  const form = page.getByRole('form', { name: 'Neuer Kontakt' });
  await form.getByLabel('Art').selectOption('call');
  await form.getByLabel('Notiz').fill('Rückruf wegen Trikotsponsoring');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('list', { name: 'Kontakte' })).toContainText('Rückruf wegen Trikotsponsoring');
});
