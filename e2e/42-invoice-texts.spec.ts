import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('invoice texts: net prices and a closing text from the invoice form', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Nina', lastName: 'Netto', joinDate: '2024-01-01', street: 'Weg 2', postalCode: '12345', city: 'Musterstadt' } });
  await page.goto('/rechnungen');
  await page.getByRole('button', { name: 'Rechnung schreiben' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rechnung schreiben' });
  await sheet.getByLabel('An (Mitglied suchen)').fill('Netto');
  await sheet.getByRole('button', { name: 'wählen' }).first().click();
  await sheet.getByLabel('Preise').selectOption('net');
  await sheet.getByLabel('Position 1: Text').fill('Vereinsheim-Miete');
  await sheet.getByLabel('Position 1: Einzelpreis in Euro').fill('100,00');
  await sheet.getByLabel('Position 1: Umsatzsteuer').selectOption('19');
  await sheet.getByLabel('Text unter den Positionen (optional)').fill('Vielen Dank!');
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/invoices') && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Als Entwurf speichern' }).click();
  const body = await (await created).json();
  expect(body.lines[0]).toMatchObject({ unitCents: 11900 });
  expect(body.closingText).toBe('Vielen Dank!');
});
