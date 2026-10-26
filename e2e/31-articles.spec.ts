import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('articles: define an article and pick it into an invoice line', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Kai', lastName: 'Kaufmann', joinDate: '2024-01-01', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt' } });
  await page.goto('/rechnungen/artikel');
  const form = page.getByRole('form', { name: 'Neuer Artikel' });
  await form.getByLabel('Bezeichnung').fill('Trainingsanzug');
  await form.getByLabel('Preis').fill('49,90');
  await form.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByRole('table', { name: 'Artikel' })).toContainText('Trainingsanzug');

  await page.getByRole('navigation', { name: 'Rechnungen' }).getByRole('link', { name: 'Rechnungen' }).click();
  await page.getByRole('button', { name: 'Rechnung schreiben' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rechnung schreiben' });
  await sheet.getByLabel('Artikel einfügen').selectOption({ label: 'Trainingsanzug · 49,90 €' });
  await expect(sheet.getByLabel('Position 1: Text')).toHaveValue('Trainingsanzug');
  await expect(sheet.getByLabel(/^Position 1: Einzelpreis in Euro/)).toHaveValue('49,90');
  // With "Preise zzgl. USt" the catalogue price stays the gross price it is (no VAT added on top).
  await sheet.getByLabel('Preise').selectOption('net');
  await sheet.getByLabel('Position 1: Umsatzsteuer').selectOption('19');
  await sheet.getByLabel('An (Mitglied suchen)').fill('Kaufmann');
  await sheet.getByRole('button', { name: 'wählen' }).first().click();
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/invoices') && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Als Entwurf speichern' }).click();
  expect((await (await created).json()).lines[0].totalCents).toBe(4990);
});
