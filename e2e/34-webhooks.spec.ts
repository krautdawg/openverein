import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('webhooks: an admin adds a webhook, sees the secret once and queues a test event', async ({ page }) => {
  await signIn(page);
  await page.goto('/einstellungen/webhooks');
  const form = page.getByRole('form', { name: 'Neuer Webhook' });
  await form.getByLabel('Adresse (https)').fill('http://127.0.0.1:9/hook');
  await form.getByLabel('Rechnungen').check();
  await form.getByRole('button', { name: 'Webhook anlegen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Geheimnis zum Prüfen der Signatur' })).toBeVisible();
  const item = page.getByRole('list', { name: 'Webhooks' }).getByRole('listitem').first();
  await expect(item).toContainText('Mitglieder, Rechnungen');
  await item.getByRole('button', { name: 'Test senden' }).click();
  await item.getByRole('button', { name: 'Zustellungen' }).click();
  await expect(item).toContainText('webhook.test');
});
