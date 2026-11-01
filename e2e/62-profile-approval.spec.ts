import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

test('profiles: the board approves a profile and it appears in the public feed', async ({ page, browser }) => {
  await signIn(page);
  // The club offers a profile type; a member writes a profile with it in the portal.
  await page.goto('/einstellungen/profile');
  await page.getByRole('button', { name: 'Art hinzufügen' }).click();
  // Typed key by key: the row must keep focus while its key follows the label (Codex review).
  await page.getByLabel('Bezeichnung').last().pressSequentially('Trainer:in');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Gespeichert.')).toBeVisible();
  const email = `freigabe-${Date.now()}@example.org`;
  const m = await (await page.request.post('/api/v1/members', { data: { firstName: 'Tara', lastName: 'Trainer', email, joinDate: '2020-01-01' } })).json();

  const member = await (await browser.newContext()).newPage();
  await member.request.post('/api/v1/portal/auth/request-code', { data: { email } });
  let code = '';
  await expect.poll(async () => {
    const found = await (await member.request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!found.messages?.length) return '';
    code = String((await (await member.request.get(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text).match(/\b(\d{6})\b/)?.[1] ?? '';
    return code;
  }).toMatch(/^\d{6}$/);
  await member.request.post('/api/v1/portal/auth/verify', { data: { email, code } });
  const types = await (await member.request.get(`/api/v1/portal/profiles/${m.id}`)).json();
  const typeKey = types.types.find((t: { label: string }) => t.label === 'Trainer:in').key;
  await member.request.put(`/api/v1/portal/profiles/${m.id}`, { data: { displayName: 'Tara T.', bio: 'Trainiert die Bambini.', place: null, organisation: null, links: [], typeKey, contactVisibility: 'board', hidden: false } });

  await page.goto('/mitglieder/profile');
  await page.getByRole('row', { name: /Tara Trainer/ }).click();
  await expect(page.getByText('Trainiert die Bambini.')).toBeVisible();
  await page.getByRole('button', { name: 'Diese Fassung freigeben' }).click();
  await expect(page.getByRole('button', { name: 'Freigabe zurücknehmen' })).toBeVisible();
  const feed = await (await page.request.get('/api/v1/public/profiles')).json();
  expect(feed.profiles.map((p: { name: string }) => p.name)).toContain('Tara T.');
});
