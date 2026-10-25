import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('bank booking: two fee movements booked to one expense account in one step', async ({ page }) => {
  await signIn(page);
  const h = () => ({ 'idempotency-key': randomUUID() });
  // Reuse the account on a retry (the IBAN is unique).
  const created = await page.request.post('/api/v1/bank-accounts', { headers: h(), data: { name: 'Sparkonto', iban: 'DE75512108001245126199', openingDate: '2026-01-01' } });
  const acc = created.ok() ? await created.json() : (await (await page.request.get('/api/v1/bank-accounts')).json()).find((a: { name: string }) => a.name === 'Sparkonto');
  const csv = 'Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag\n06.10.2026;Entgelt Okt;Sparkasse;;-3,50\n07.10.2026;Entgelt Okt II;Sparkasse;;-1,50';
  const imported = await page.request.post(`/api/v1/bank-accounts/${acc.id}/imports`, { headers: h(), data: { format: 'csv', content: csv } });
  expect([201, 409]).toContain(imported.status());
  await page.goto('/bank/abgleich');
  await page.getByRole('checkbox', { name: /Sparkasse -3,50/ }).check();
  await page.getByRole('checkbox', { name: /Sparkasse -1,50/ }).check();
  const bar = page.getByRole('form', { name: 'Ohne Rechnung buchen' });
  await expect(bar).toContainText('2 ausgewählt');
  await bar.getByLabel('Ausgabenkonto').selectOption({ index: 1 });
  const booked = page.waitForResponse((r) => r.url().endsWith('/api/v1/bank-transactions/book'));
  await bar.getByRole('button', { name: 'Buchen' }).click();
  const res = await booked;
  expect(res.status(), await res.text()).toBe(200);
  await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Gebucht' }).click();
  await expect(page.getByRole('table', { name: 'Kontobewegungen' })).toContainText('Buchung Nr.');
});
