import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

test('household proxy: the payer sees and manages the child membership in the portal', async ({ page, browser, request }) => {
  await signIn(page);
  const email = `zahler-${Date.now()}@example.org`;
  const h = () => ({ 'idempotency-key': randomUUID() });
  const payer = await (await page.request.post('/api/v1/members', { headers: h(), data: { firstName: 'Petra', lastName: 'Proxy', email, joinDate: '2024-01-01' } })).json();
  const child = await (await page.request.post('/api/v1/members', { headers: h(), data: { firstName: 'Paula', lastName: 'Proxy', birthDate: '2016-05-01', joinDate: '2024-01-01' } })).json();
  expect((await page.request.post('/api/v1/households', { headers: h(), data: { name: 'Familie Proxy', payerPersonId: payer.personId, memberIds: [payer.id, child.id] } })).ok()).toBe(true);

  const portal = await (await browser.newContext()).newPage();
  await portal.goto('/portal');
  await portal.getByLabel('E-Mail').fill(email);
  await portal.getByRole('button', { name: 'Code schicken' }).click();
  let code = '';
  await expect.poll(async () => {
    const found = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!found.messages?.length) return '';
    code = String((await (await request.get(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text).match(/\b(\d{6})\b/)?.[1] ?? '';
    return code;
  }).not.toBe('');
  await portal.getByLabel('Code').fill(code);
  await portal.getByRole('button', { name: 'Anmelden' }).click();
  const card = portal.getByRole('region', { name: 'Paula Proxy' });
  await expect(card).toContainText('Du verwaltest diese Mitgliedschaft als zahlende Person des Haushalts.');
  await expect(card.getByRole('button', { name: 'Daten ändern' })).toBeVisible();
});
