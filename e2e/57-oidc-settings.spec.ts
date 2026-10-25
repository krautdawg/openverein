import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('oidc settings: the admin sees the redirect address and saves the (switched-off) setup', async ({ page }) => {
  await signIn(page);
  await page.goto('/einstellungen/sicherheit');
  const form = page.getByRole('form', { name: 'Anmeldung über das Vereins-Konto' });
  await expect(form).toContainText('/api/v1/auth/oidc/callback');
  await form.getByLabel('Bezeichnung auf der Anmeldeseite').fill('Vereins-Google');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(form.getByRole('status')).toContainText('Gespeichert');
  // Switched off: the sign-in page offers no provider button.
  await page.context().clearCookies();
  await page.goto('/anmelden');
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Mit .* anmelden/ })).toHaveCount(0);
});
