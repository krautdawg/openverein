import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('census: gender set in the member sheet shows up in the Bestandserhebung', async ({ page }) => {
  await signIn(page);
  const year = new Date().getFullYear();
  const m = await (await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Clara', lastName: 'Zensus', birthDate: `${year - 10}-03-01`, joinDate: `${year - 1}-01-01` } })).json();
  await page.goto(`/mitglieder/${m.id}`);
  await page.getByRole('dialog', { name: 'Zensus, Clara' }).getByLabel('Geschlecht').selectOption('female');
  await expect(page.getByRole('dialog', { name: 'Zensus, Clara' }).getByLabel('Geschlecht')).toHaveValue('female');

  await page.goto('/mitglieder/bestandserhebung');
  const total = page.getByRole('table', { name: `Bestandserhebung ${year}` }).getByRole('row', { name: /Verein gesamt/ });
  await expect(total).toContainText('1 w');
});
