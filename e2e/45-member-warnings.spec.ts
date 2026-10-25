import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('member warnings: direct debit without a mandate shows on the member record', async ({ page }) => {
  await signIn(page);
  const h = () => ({ 'idempotency-key': randomUUID() });
  const m = await (await page.request.post('/api/v1/members', { headers: h(), data: { firstName: 'Mia', lastName: 'Mandatlos', joinDate: '2024-01-01', street: 'Weg 3', postalCode: '12345', city: 'Musterstadt' } })).json();
  await page.request.patch(`/api/v1/members/${m.id}/payment-method`, { headers: h(), data: { paymentMethod: 'direct_debit' } });
  await page.goto(`/mitglieder/${m.id}`);
  await expect(page.getByRole('list', { name: 'Hinweise' })).toContainText('Zahlt per Lastschrift, aber es gibt kein gültiges Mandat.');
});
