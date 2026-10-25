import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('offers: write and issue an offer, then turn it into an invoice draft', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Anton', lastName: 'Angebot', joinDate: '2024-01-01', street: 'Weg 4', postalCode: '12345', city: 'Musterstadt' } });
  await page.goto('/rechnungen/angebote');
  await page.getByRole('button', { name: 'Angebot schreiben' }).click();
  const sheet = page.getByRole('dialog', { name: 'Angebot schreiben' });
  await sheet.getByLabel('An (Mitglied suchen)').fill('Angebot');
  await sheet.getByRole('button', { name: 'wählen' }).first().click();
  await sheet.getByLabel('Position 1: Text').fill('Vereinsheim Samstag');
  await sheet.getByLabel('Position 1: Einzelpreis in Euro').fill('150,00');
  await sheet.getByRole('button', { name: 'Ausstellen' }).click();
  const detail = page.getByRole('dialog', { name: /^Angebot A-/ });
  await expect(detail).toContainText('Verschickt');
  await detail.getByRole('button', { name: 'In Rechnung umwandeln' }).click();
  await expect(page).toHaveURL(/\/rechnungen\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('dialog')).toContainText('Vereinsheim Samstag');
});
