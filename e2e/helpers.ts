import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { codeAt, currentStep } from '../src/server/auth/totp.ts';

export const ADMIN = { email: 'erika@example.org', password: 'korrekt-pferd-batterie' };
// The first spec sets up TOTP for the admin and leaves the session here for the specs after it.
const STATE = 'test-results/.e2e-admin.json';

export function saveAdmin(state: { secret: string; cookies: { name: string; value: string; domain: string; path: string }[] }) {
  writeFileSync(STATE, JSON.stringify(state));
}

/** Signs in as the e2e admin: reuses the stored session, else logs in (with TOTP), else sets up the club. */
export async function signIn(page: Page) {
  const setup = await page.request.get('/api/v1/setup');
  if ((await setup.json()).needsSetup) {
    await page.request.post('/api/v1/setup', { data: { clubName: 'TSV Musterstadt 1890 e.V.', name: 'Erika Mustermann', ...ADMIN } });
    return;
  }
  const saved = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as { secret: string; cookies: { name: string; value: string; domain: string; path: string }[] }) : null;
  if (saved) {
    await page.context().addCookies(saved.cookies);
    if ((await page.request.get('/api/v1/auth/me')).ok()) return;
  }
  const r = await (await page.request.post('/api/v1/auth/login', { data: ADMIN })).json();
  if (r.totpRequired && saved) await page.request.post('/api/v1/auth/login/totp', { data: { ticket: r.ticket, code: codeAt(saved.secret, currentStep() + 1) } });
}
