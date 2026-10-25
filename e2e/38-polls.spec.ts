import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

test('polls: the board asks, a member answers in the portal, the count shows up', async ({ page, browser, request }) => {
  await signIn(page);
  const email = `umfrage-${Date.now()}@example.org`;
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Uwe', lastName: 'Umfrage', email, joinDate: '2024-01-01' } });
  await page.goto('/kommunikation/umfragen');
  const form = page.getByRole('form', { name: 'Neue Umfrage' });
  await form.getByLabel('Frage').fill('Neue Trikots in Blau?');
  await form.getByLabel('Antwort 1').fill('Ja');
  await form.getByLabel('Antwort 2').fill('Nein');
  await form.getByLabel('Läuft bis').fill(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  await form.getByRole('button', { name: 'Umfrage starten' }).click();
  await expect(page.getByRole('list', { name: 'Umfragen' })).toContainText('Neue Trikots in Blau?');

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
  const answer = portal.getByRole('form', { name: 'Antwort: Neue Trikots in Blau?' });
  await answer.getByLabel('Ja').check();
  await answer.getByRole('button', { name: 'Antworten' }).click();
  await expect(answer.getByText('Du hast geantwortet.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('list', { name: 'Umfragen' }).getByRole('listitem').filter({ hasText: 'Neue Trikots in Blau?' })).toContainText(/1 von \d+ haben geantwortet/);
});
