import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

test('expenses: a member submits a receipt in the portal, the treasurer accepts it into an open receipt', async ({ page, browser, request }) => {
  await signIn(page);
  const email = `auslage-${Date.now()}@example.org`;
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Eli', lastName: 'Erstattung', email, joinDate: '2024-01-01' } });

  const member = await (await browser.newContext()).newPage();
  await member.goto('/portal');
  await member.getByLabel('E-Mail').fill(email);
  await member.getByRole('button', { name: 'Code schicken' }).click();
  let code = '';
  await expect.poll(async () => {
    const found = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!found.messages?.length) return '';
    code = String((await (await request.get(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text).match(/\b(\d{6})\b/)?.[1] ?? '';
    return code;
  }).not.toBe('');
  await member.getByLabel('Code').fill(code);
  await member.getByRole('button', { name: 'Anmelden' }).click();
  await member.getByRole('link', { name: 'Auslagen' }).click();
  const form = member.getByRole('form', { name: 'Auslage einreichen' });
  await form.getByLabel('Wofür').fill('Pflaster für den Sanitätskasten');
  await form.getByLabel('Bezahlt am').fill('2026-03-02');
  await form.getByLabel('Betrag').fill('12,80');
  await form.getByLabel('IBAN für die Erstattung').fill('DE02120300000000202051');
  await form.getByLabel('Beleg (PDF oder Foto)').setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Bon') });
  await form.getByRole('button', { name: 'Einreichen' }).click();
  await expect(member.getByRole('status').filter({ hasText: 'Eingereicht' })).toBeVisible();

  await page.goto('/buchhaltung/belege');
  const claims = page.getByRole('list', { name: 'Eingereichte Auslagen' });
  await expect(claims).toContainText('Pflaster für den Sanitätskasten');
  await claims.getByRole('button', { name: 'Annehmen …' }).first().click();
  const sheet = page.getByRole('dialog', { name: /Auslage annehmen/ });
  await sheet.getByLabel('Ausgabenkonto').selectOption({ index: 1 });
  await sheet.getByRole('button', { name: 'Annehmen' }).click();
  await expect(page.getByRole('table', { name: 'Belege' })).toContainText('Auslage Erstattung, Eli');
});
