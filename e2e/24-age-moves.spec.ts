import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('age rule: set it in the group sheet and see who moves next', async ({ page }) => {
  await signIn(page);
  const headers = () => ({ 'idempotency-key': randomUUID() });
  const adults = await (await page.request.post('/api/v1/groups', { headers: headers(), data: { name: 'Herren', shortCode: 'HER' } })).json();
  const youth = await (await page.request.post('/api/v1/groups', { headers: headers(), data: { name: 'A-Jugend', shortCode: 'AJ' } })).json();
  const soon = new Date();
  soon.setUTCFullYear(soon.getUTCFullYear() - 18);
  soon.setUTCDate(soon.getUTCDate() + 20);
  await page.request.post('/api/v1/members', { headers: headers(), data: { firstName: 'Timo', lastName: 'Wechsel', birthDate: soon.toISOString().slice(0, 10), joinDate: '2020-01-01', groupIds: [youth.id] } });

  await page.goto(`/gruppen/${youth.id}`);
  const rule = page.getByRole('form', { name: 'Wechsel nach Alter' });
  await rule.getByLabel('Alter').fill('18');
  await rule.getByLabel('Zielgruppe').selectOption({ label: adults.name });
  await rule.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('list', { name: 'Anstehende Wechsel' })).toContainText('Wechsel, Timo');
});
