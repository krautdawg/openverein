import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('event child price: a reduced fee for children shows on the event', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/calendars', { headers: { 'idempotency-key': randomUUID() }, data: { name: 'Freizeiten' } });
  await page.goto('/termine');
  const next = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
  await page.getByRole('button', { name: 'Termin anlegen' }).click();
  const form = page.getByRole('dialog', { name: 'Termin anlegen' });
  await form.getByLabel('Titel').fill('Ferienfreizeit');
  await form.getByLabel('Datum').fill(next);
  await form.getByLabel('Teilnahmegebühr (optional)').fill('30,00');
  await form.getByLabel('Ermäßigt für Kinder (optional)').fill('10,00');
  await form.getByLabel('bis einschließlich Alter').fill('13');
  await form.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByRole('dialog', { name: 'Ferienfreizeit' })).toContainText('Kinder bis 13 Jahre 10,00 €');
});
