import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('bank booking: two fee movements booked to one expense account in one step', async ({ page }) => {
  await signIn(page);
  const h = () => ({ 'idempotency-key': randomUUID() });
  const acc = await (await page.request.post('/api/v1/bank-accounts', { headers: h(), data: { name: 'Sparkonto', iban: 'DE75512108001245126199', openingDate: '2026-01-01' } })).json();
  const csv = 'Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag\n06.10.2026;Entgelt Okt;Sparkasse;;-3,50\n07.10.2026;Entgelt Okt II;Sparkasse;;-1,50';
  expect((await page.request.post(`/api/v1/bank-accounts/${acc.id}/imports`, { headers: h(), data: { format: 'csv', content: csv } })).ok()).toBe(true);
  await page.goto('/bank/abgleich');
  await page.getByRole('checkbox', { name: /Sparkasse -3,50/ }).check();
  await page.getByRole('checkbox', { name: /Sparkasse -1,50/ }).check();
  const bar = page.getByRole('form', { name: 'Ohne Rechnung buchen' });
  await expect(bar).toContainText('2 ausgewählt');
  await bar.getByLabel('Ausgabenkonto').selectOption({ index: 1 });
  await bar.getByRole('button', { name: 'Buchen' }).click();
  await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Gebucht' }).click();
  await expect(page.getByRole('table', { name: 'Kontobewegungen' })).toContainText('Buchung Nr.');
});
