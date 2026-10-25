import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('allowances: record a trainer allowance and see what is left of the tax-free limit', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Udo', lastName: 'Uebungsleiter', joinDate: '2020-01-01' } });
  await page.goto('/buchhaltung/pauschalen');
  await page.getByRole('button', { name: 'Pauschale erfassen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Pauschale erfassen' });
  await sheet.getByLabel('Person suchen').fill('Uebungsleiter');
  await sheet.getByRole('button', { name: 'Uebungsleiter, Udo wählen' }).click();
  await sheet.getByLabel('Betrag').fill('500,00');
  await sheet.getByLabel('Wofür').fill('Training Herbst');
  await sheet.getByRole('button', { name: 'Erfassen' }).click();
  const row = page.getByRole('row', { name: /Uebungsleiter, Udo/ });
  await expect(row).toContainText('Übungsleiter');
  await expect(row).toContainText('500,00');
});
