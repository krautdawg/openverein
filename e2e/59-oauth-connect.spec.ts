import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { codeAt, currentStep } from '../src/server/auth/totp.ts';
import { ADMIN, signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';
const REDIRECT = 'http://127.0.0.1:53682/callback';

/** A registered client and the authorize URL a KI client would open (DCR, PKCE). */
async function startFlow(page: Page) {
  const reg = await (await page.request.post('/oauth/register', { data: { client_name: 'Claude', redirect_uris: [REDIRECT] } })).json();
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const base = new URL(page.url() === 'about:blank' ? 'http://localhost:3399' : page.url()).origin;
  return `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope: 'read', resource: `${base}/mcp` })}`;
}

/** Catches the redirect back to the client and returns its URL. */
async function callback(page: Page) {
  let hit: URL | null = null;
  await page.route('http://127.0.0.1:53682/**', (r) => {
    hit = new URL(r.request().url());
    return r.fulfill({ body: 'ok' });
  });
  return () => hit as URL | null;
}

test('oauth: an admin who signs in during the flow comes back to the consent and gets to the client', async ({ browser }) => {
  // Make sure the club and the admin exist (and their second factor), then start signed out.
  const setupPage = await browser.newPage();
  await signIn(setupPage);
  await setupPage.close();
  const page = await (await browser.newContext()).newPage();
  const hit = await callback(page);
  await page.goto(await startFlow(page));
  await expect(page).toHaveURL(/\/verbinden\?/);
  await page.getByRole('link', { name: 'Ich arbeite in der Vereinsverwaltung' }).click();
  await expect(page).toHaveURL(/\/anmelden/);
  await page.getByLabel('E-Mail').fill(ADMIN.email);
  await page.getByLabel('Passwort').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  const saved = existsSync('test-results/.e2e-admin.json') ? (JSON.parse(readFileSync('test-results/.e2e-admin.json', 'utf8')) as { secret: string }) : null;
  // The e2e admin has a second factor: the code step comes first (or, without one, the next page).
  await page.waitForFunction(() => !location.pathname.startsWith('/anmelden') || !!document.querySelector('input[autocomplete="one-time-code"]'));
  if (saved && (await page.getByLabel('Code').isVisible())) {
    await page.getByLabel('Code').fill(codeAt(saved.secret, currentStep() + 1));
    await page.getByRole('button', { name: /Bestätigen|Anmelden/ }).click();
  }
  await expect(page).toHaveURL(/\/verbinden\?/);
  await expect(page.getByRole('heading', { name: 'Claude verbinden?' })).toBeVisible();
  await page.getByRole('button', { name: 'Erlauben' }).click();
  await expect.poll(() => hit()?.searchParams.get('state') ?? null).toBe('st-1');
  expect(hit()!.searchParams.get('code')).toBeTruthy();
});

test('oauth: a member who signs in to the portal during the flow comes back to the consent', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin);
  const email = `oauth-${Date.now()}@example.org`;
  await admin.request.post('/api/v1/members', { data: { firstName: 'Olga', lastName: 'Oauth', email, joinDate: '2024-01-01' } });
  await admin.close();

  const page = await (await browser.newContext()).newPage();
  const hit = await callback(page);
  await page.goto(await startFlow(page));
  await page.getByRole('link', { name: 'Ich bin Mitglied' }).click();
  await expect(page).toHaveURL(/\/portal\/anmelden/);
  await page.getByLabel('E-Mail').fill(email);
  await page.getByRole('button', { name: 'Code schicken' }).click();
  await expect(page.getByLabel('Code')).toBeVisible();
  let code = '';
  await expect.poll(async () => {
    const found = await (await page.request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!found.messages?.length) return '';
    code = String((await (await page.request.get(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text).match(/\b(\d{6})\b/)?.[1] ?? '';
    return code;
  }).toMatch(/^\d{6}$/);
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/portal\/verbinden\?/);
  await page.getByRole('button', { name: 'Erlauben' }).click();
  await expect.poll(() => hit()?.searchParams.get('state') ?? null).toBe('st-1');
});
