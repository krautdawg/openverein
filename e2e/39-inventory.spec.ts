import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('inventory: add an item, lend it to a member, take it back', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Lina', lastName: 'Leihe', joinDate: '2020-01-01' } });
  await page.goto('/dokumente/inventar');
  await page.getByRole('button', { name: 'Gegenstand anlegen' }).click();
  const add = page.getByRole('dialog', { name: 'Gegenstand anlegen' });
  await add.getByLabel('Bezeichnung').fill('Beamer');
  await add.getByLabel('Ort').fill('Vereinsheim');
  await add.getByRole('button', { name: 'Anlegen' }).click();
  const row = page.getByRole('row', { name: /Beamer/ });
  await expect(row).toContainText('1 von 1');
  await row.getByRole('button', { name: 'Beamer ausleihen' }).click();
  const lend = page.getByRole('dialog', { name: 'Ausleihen: Beamer' });
  await lend.getByLabel('Mitglied suchen').fill('Leihe');
  await lend.getByRole('button', { name: 'Leihe, Lina wählen' }).click();
  await lend.getByRole('button', { name: 'Ausleihen', exact: true }).click();
  await expect(row).toContainText('Leihe, Lina');
  await expect(row).toContainText('0 von 1');
  await row.getByRole('button', { name: /Rückgabe von Leihe, Lina/ }).click();
  await expect(row).toContainText('1 von 1');
});
