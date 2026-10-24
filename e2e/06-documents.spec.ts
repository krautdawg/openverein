import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('documents: folder, upload, new version, download', async ({ page }) => {
  await signIn(page);
  await page.goto('/dokumente');
  await page.getByRole('button', { name: 'Ordner anlegen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Neuer Ordner' });
  await sheet.getByLabel('Name').fill('Satzung');
  await sheet.getByRole('button', { name: 'Ordner anlegen' }).click();
  await expect(page.getByRole('navigation', { name: 'Ordnerpfad' })).toContainText('Satzung');

  await page.locator('input[type=file]').first().setInputFiles({ name: 'Satzung-2024.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Fassung 2024') });
  await page.getByRole('row', { name: /Satzung-2024\.pdf/ }).click();
  const file = page.getByRole('dialog', { name: 'Satzung-2024.pdf' });
  await expect(file.getByText('v1')).toBeVisible();
  await file.locator('input[type=file]').setInputFiles({ name: 'Satzung-2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Fassung 2026') });
  await expect(page.getByRole('row', { name: /Satzung-2024\.pdf.*v2/ })).toBeVisible();

  const id = await page.evaluate(async () => (await (await fetch('/api/v1/files?folderId=' + new URL(location.href).searchParams.get('ordner'))).json())[0].id);
  const body = await (await page.request.get(`/api/v1/files/${id}/content`)).text();
  expect(body).toBe('%PDF-1.4 Fassung 2026');
});
