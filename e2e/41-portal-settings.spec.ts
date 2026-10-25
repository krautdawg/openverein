import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('portal settings: the club switches a portal function off and on again', async ({ page }) => {
  await signIn(page);
  await page.goto('/einstellungen');
  const resign = page.getByRole('region', { name: 'Mitgliederportal' }).getByRole('checkbox', { name: 'Kündigen' });
  await expect(resign).toBeChecked();
  // Controlled by the saved value: it flips once the server has stored it.
  await resign.click();
  await expect(resign).not.toBeChecked();
  await expect.poll(async () => (await (await page.request.get('/api/v1/organization')).json()).portalFeatures.resignation).toBe(false);
  await resign.click();
  await expect(resign).toBeChecked();
  await expect.poll(async () => (await (await page.request.get('/api/v1/organization')).json()).portalFeatures.resignation).toBe(true);
});
