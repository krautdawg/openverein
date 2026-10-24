import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

test('portal: member signs in with a mailed code, changes the phone number and asks for a new address', async ({ page, request }) => {
  await signIn(page);
  const email = `portal-${Date.now()}@example.org`;
  await page.request.post('/api/v1/members', { data: { firstName: 'Pia', lastName: 'Portal', email, joinDate: '2024-01-01' } });

  await page.goto('/portal');
  await expect(page).toHaveURL(/\/portal\/anmelden/);
  await page.getByLabel('E-Mail').fill(email);
  await page.getByRole('button', { name: 'Code schicken' }).click();
  await expect(page.getByLabel('Code')).toBeVisible();
  let code = '';
  await expect.poll(async () => {
    const found = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!found.messages?.length) return '';
    code = String((await (await request.get(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text).match(/\b(\d{6})\b/)?.[1] ?? '';
    return code;
  }).not.toBe('');
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  await expect(page.getByRole('heading', { name: 'Deine Mitgliedschaft' })).toBeVisible();
  await page.getByRole('button', { name: 'Daten ändern' }).click();
  await page.getByRole('button', { name: /Telefon/ }).click();
  await page.getByLabel('Telefon').fill('0171 2223334');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('button', { name: /Telefon\s*0171 2223334/ })).toBeVisible();
  await page.getByRole('button', { name: /^Ort/ }).click();
  await page.getByLabel('Ort', { exact: true }).fill('Neustadt');
  await page.getByRole('button', { name: 'Zur Prüfung senden' }).click();
  await expect(page.getByText('wartet: Neustadt')).toBeVisible();

  await page.getByRole('link', { name: 'Rechnungen' }).click();
  await expect(page.getByRole('heading', { name: 'Rechnungen' })).toBeVisible();
});
