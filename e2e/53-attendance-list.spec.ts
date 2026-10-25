import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('attendance list: a calendar offers this year\'s attendance as CSV', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/calendars', { headers: { 'idempotency-key': randomUUID() }, data: { name: 'Jugendtraining' } });
  await page.goto('/termine');
  await page.getByRole('button', { name: 'Kalender', exact: true }).click();
  const year = new Date().getFullYear();
  const link = page.getByRole('listitem').filter({ hasText: 'Jugendtraining' }).getByRole('link', { name: `Anwesenheit ${year}` });
  const download = page.waitForEvent('download');
  await link.click();
  expect((await download).suggestedFilename()).toMatch(/^Anwesenheit-Jugendtraining-/);
});
