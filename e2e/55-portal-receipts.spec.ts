import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

test('portal receipts: a member downloads their donation receipt in the portal', async ({ page, request }) => {
  await signIn(page);
  const h = () => ({ 'idempotency-key': randomUUID() });
  const email = `spende-${Date.now()}@example.org`;
  const year = new Date().getFullYear();
  const member = await (await page.request.post('/api/v1/members', { headers: h(), data: { firstName: 'Sina', lastName: 'Spende', email, joinDate: '2024-01-01', street: 'Lindenweg 3', postalCode: '12345', city: 'Musterstadt' } })).json();
  // Exemption data exists from the donations spec; set it again in case this spec runs alone.
  await page.request.put('/api/v1/donations/settings', { data: { kind: 'freistellung', office: 'Musterstadt', taxNumber: '12/345/67890', date: `${year - 1}-05-01`, period: '2021–2023', purposes: 'des Sports (§ 52 Abs. 2 Satz 1 Nr. 21 AO)', signer: 'Erika Mustermann, Kassenwartin' } });
  const donation = await (await page.request.post('/api/v1/donations', { headers: h(), data: { personId: member.personId, date: `${year}-01-10`, amountCents: 5000 } })).json();
  const receipt = await (await page.request.post('/api/v1/donation-receipts', { headers: h(), data: { personId: member.personId, donationIds: [donation.id] } })).json();
  expect(receipt.number).toBeTruthy();

  await page.goto('/portal');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByRole('button', { name: 'Code schicken' }).click();
  let code = '';
  await expect.poll(async () => {
    const found = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!found.messages?.length) return '';
    code = String((await (await request.get(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text).match(/\b(\d{6})\b/)?.[1] ?? '';
    return code;
  }).not.toBe('');
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.getByRole('link', { name: 'Dokumente' }).click();
  await expect(page.getByRole('heading', { name: 'Deine Zuwendungsbestätigungen' })).toBeVisible();
  await expect(page.getByRole('link', { name: receipt.number })).toBeVisible();
});
