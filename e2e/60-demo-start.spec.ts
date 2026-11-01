import { expect, test } from '@playwright/test';
import { ADMIN } from './helpers.ts';

// A club must exist (else every page is the first-run setup); set it up apart from the signed-out browser.
test.beforeEach(async ({ request }) => {
  if ((await (await request.get('/api/v1/setup')).json()).needsSetup) await request.post('/api/v1/setup', { data: { clubName: 'TSV Musterstadt 1890 e.V.', name: 'Erika Mustermann', ...ADMIN } });
});

/** The demo start page (DEMO_MODE only). The e2e server runs without demo mode; the demo case answers /config itself. */
test('demo start: without demo mode a signed-out visitor goes straight to the sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/anmelden$/);
  await expect(page.getByRole('heading', { name: 'OpenVerein ausprobieren' })).toHaveCount(0);
});

test('demo start: in demo mode a signed-out visitor chooses how to look around', async ({ page }) => {
  await page.route('**/api/v1/config', (r) => r.fulfill({ json: { demo: true, demoLogin: { email: 'demo@openverein.example', password: 'verein-demo-2026' }, demoResetHours: 24 } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'OpenVerein ausprobieren' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  // The agent lines are built from this address.
  await expect(page.getByText(`${origin}/mcp`, { exact: true })).toBeVisible();
  await expect(page.getByText(`curl -fsSLO ${origin}/ov.mjs`)).toBeVisible();
  await expect(page.getByText('/plugin install openverein@openverein')).toBeVisible();
  await expect(page.getByText(/alle 24 Stunden von vorn/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Quellcode auf GitHub' })).toHaveAttribute('href', 'https://github.com/krautdawg/openverein');
  await expect(page.getByRole('link', { name: /Als Mitglied ansehen/ })).toHaveAttribute('href', '/portal');
  await page.getByRole('link', { name: /Als Vorstand ansehen/ }).click();
  await expect(page).toHaveURL(/\/anmelden$/);
  await expect(page.getByText('Demo-Zugang:')).toBeVisible();
});
