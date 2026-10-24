import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('communication: write to all members with a placeholder and watch the delivery', async ({ page }) => {
  await signIn(page);
  const group = await (await page.request.post('/api/v1/groups', { data: { name: 'Chor', shortCode: 'CHR' } })).json();
  await page.request.post('/api/v1/members', { data: { firstName: 'Mia', lastName: 'Mail', email: 'mia.mail@example.org', joinDate: '2024-01-01', groupIds: [group.id] } });
  await page.request.post('/api/v1/members', { data: { firstName: 'Otto', lastName: 'Ohne', joinDate: '2024-01-01', groupIds: [group.id] } });
  await page.goto(`/gruppen/${group.id}`);
  await page.getByRole('link', { name: 'E-Mail an die Gruppe' }).click();
  await expect(page.getByText('1 ausgelassen')).toBeVisible();
  await page.getByLabel('Betreff').fill('Training fällt aus, {{vorname}}');
  await expect(page.getByRole('complementary', { name: 'Vorschau' }).getByText('Training fällt aus, Mia')).toBeVisible();
  await page.getByRole('button', { name: 'An 1 senden' }).click();
  await page.getByRole('button', { name: 'Ja, senden' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Unterwegs an 1' })).toBeVisible();
  const row = page.getByRole('table', { name: 'Gesendete E-Mails' }).getByRole('row', { name: /Training fällt aus/ });
  await expect(row).toContainText('1 / 1', { timeout: 15_000 });
  await row.click();
  await expect(page.getByRole('dialog').getByText('Zugestellt an den Mailserver')).toBeVisible();
});
