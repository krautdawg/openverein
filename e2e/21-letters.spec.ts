import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('letters: an invoice for a member without e-mail is printed from one merged PDF', async ({ page }) => {
  await signIn(page);
  const headers = () => ({ 'idempotency-key': randomUUID() });
  const member = await (await page.request.post('/api/v1/members', { headers: headers(), data: { firstName: 'Bert', lastName: 'Brief', joinDate: '2025-01-01', street: 'Postweg 3', postalCode: '10115', city: 'Berlin' } })).json();
  const draft = await (await page.request.post('/api/v1/invoices', { headers: headers(), data: { memberId: member.id, lines: [{ text: 'Hallenmiete', unitCents: 2500 }] } })).json();
  expect((await page.request.post(`/api/v1/invoices/${draft.id}/issue`, { headers: headers(), data: {} })).ok()).toBe(true);

  await page.goto(`/rechnungen/${draft.id}`);
  const sheet = page.getByRole('dialog', { name: /Rechnung R-/ });
  await sheet.getByRole('button', { name: 'Per E-Mail senden' }).click();
  await sheet.getByRole('button', { name: 'Ja, senden' }).click();
  await expect(sheet.getByText('Als Brief drucken')).toBeVisible();
  const download = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Brief als PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/^Briefe-\d{4}-\d{2}-\d{2}\.pdf$/);
});
