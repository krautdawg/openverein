import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('duplicates: a pair is found and the newer record is archived', async ({ page }) => {
  await signIn(page);
  for (const [first, last, join] of [['Doris', 'Doppel', '2015-01-01'], ['Doris', 'Doppel', '2025-01-01']]) {
    await page.request.post('/api/v1/members', { data: { firstName: first, lastName: last, birthDate: '1975-05-05', email: 'doris@example.org', joinDate: join } });
  }
  await page.goto('/mitglieder');
  await page.getByRole('link', { name: 'Dubletten' }).click();
  const pair = page.getByRole('list', { name: 'Mögliche Dubletten' }).getByRole('listitem').filter({ hasText: 'Doris Doppel' }).first();
  await expect(pair).toContainText('%');
  await pair.getByRole('button', { name: /archivieren$/ }).first().click();
  await expect(page.getByRole('status')).toContainText('archiviert');
});
