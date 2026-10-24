import type { Page } from '@playwright/test';

export const ADMIN = { email: 'erika@example.org', password: 'korrekt-pferd-batterie' };

/** Signs in as the e2e admin, setting up the club first if this is a fresh database. */
export async function signIn(page: Page) {
  const setup = await page.request.get('/api/v1/setup');
  if ((await setup.json()).needsSetup) {
    await page.request.post('/api/v1/setup', { data: { clubName: 'TSV Musterstadt 1890 e.V.', name: 'Erika Mustermann', ...ADMIN } });
  } else {
    await page.request.post('/api/v1/auth/login', { data: ADMIN });
  }
}
