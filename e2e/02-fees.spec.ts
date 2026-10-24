import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('fees: plan, assignment, fee run preview and posting, payment', async ({ page }) => {
  await signIn(page);
  await page.request.patch('/api/v1/organization', { data: { street: 'Sportplatzweg 1', postalCode: '12345', city: 'Musterstadt', iban: 'DE89370400440532013000' } });
  const member = await (await page.request.post('/api/v1/members', { data: { firstName: 'Rita', lastName: 'Rechnung', joinDate: '2025-01-01', street: 'Am Hang 2', postalCode: '12345', city: 'Musterstadt' } })).json();

  await page.goto('/beitraege');
  await page.getByRole('button', { name: 'Beitragsart anlegen' }).click();
  const form = page.getByRole('form', { name: 'Neue Beitragsart' });
  await form.getByLabel('Name').fill('Erwachsene');
  await form.getByLabel('Betrag je Zeitraum').fill('120,00');
  await form.getByLabel('Gültig ab').fill('2025-01-01');
  await form.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByRole('table', { name: 'Beitragsarten' })).toContainText('120,00 €');

  await page.goto(`/mitglieder/${member.id}`);
  const sheet = page.getByRole('dialog', { name: 'Rechnung, Rita' });
  await sheet.getByLabel('Zahlungsart').selectOption('transfer');
  await sheet.getByRole('button', { name: 'Beitrag zuordnen' }).click();
  await sheet.getByLabel('ab').fill('2025-01-01');
  await sheet.getByRole('button', { name: 'Zuordnen' }).click();
  await expect(sheet.getByText('Hauptbeitrag · ab 01.01.2025')).toBeVisible();

  await page.goto('/beitraege/laeufe');
  await page.getByLabel('Abrechnen bis (Stichtag)').fill('2025-12-31');
  await page.getByRole('button', { name: 'Vorschau erstellen' }).click();
  await expect(page.getByRole('table', { name: 'Vorschau' })).toContainText('Rechnung, Rita');
  await page.getByRole('button', { name: '1 Rechnungen buchen' }).click();
  await page.getByRole('button', { name: 'Ja, buchen' }).click();
  await expect(page.getByText('Gebucht am')).toBeVisible();

  await page.getByRole('link', { name: 'Rechnungen ansehen' }).click();
  await page.getByRole('table', { name: 'Rechnungen' }).getByText('Rita Rechnung').click();
  const inv = page.getByRole('dialog', { name: /Beitragsrechnung R-/ });
  await expect(inv).toContainText('120,00 €');
  const pdf = await page.request.get(await inv.getByRole('link', { name: 'PDF' }).getAttribute('href') as string);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await inv.getByRole('button', { name: 'Zahlung erfassen' }).click();
  await inv.getByRole('button', { name: 'Zahlung buchen' }).click();
  await expect(inv.getByText('Bezahlt')).toBeVisible();
});
