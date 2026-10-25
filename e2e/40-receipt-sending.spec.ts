import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('receipt sending: the year receipts go out by e-mail, the rest as one letter PDF', async ({ page }) => {
  await signIn(page);
  const h = () => ({ 'idempotency-key': randomUUID() });
  const year = new Date().getFullYear();
  await page.request.post('/api/v1/donations', { headers: h(), data: { donor: { lastName: 'Briefspender', firstName: 'Bea', street: 'Postweg 1', postalCode: '12345', city: 'Musterstadt' }, date: `${year}-01-05`, amountCents: 5000 } });
  await page.request.post('/api/v1/donation-receipts/annual', { headers: h(), data: { year } });
  await page.goto(`/spenden/bestaetigungen?jahr=${year}`);
  await page.getByRole('button', { name: 'Bestätigungen verschicken' }).click();
  await page.getByRole('button', { name: 'Ja, verschicken' }).click();
  const status = page.getByRole('status').filter({ hasText: 'per E-Mail unterwegs' });
  await expect(status).toBeVisible();
  const download = page.waitForEvent('download');
  await status.getByRole('button', { name: 'Briefe als PDF' }).click();
  expect((await download).suggestedFilename()).toBe('Zuwendungsbestaetigungen.pdf');
});
