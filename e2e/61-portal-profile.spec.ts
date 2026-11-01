import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

test('portal profile: a member writes a profile, adds a link and keeps it unpublished', async ({ page, browser }) => {
  await signIn(page);
  const email = `profil-${Date.now()}@example.org`;
  await page.request.post('/api/v1/members', { data: { firstName: 'Pia', lastName: 'Profil', email, joinDate: '2024-01-01' } });
  const member = await (await browser.newContext()).newPage();
  await member.goto('/portal');
  await member.getByLabel('E-Mail').fill(email);
  await member.getByRole('button', { name: 'Code schicken' }).click();
  let code = '';
  await expect.poll(async () => {
    const found = await (await member.request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!found.messages?.length) return '';
    code = String((await (await member.request.get(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text).match(/\b(\d{6})\b/)?.[1] ?? '';
    return code;
  }).toMatch(/^\d{6}$/);
  await member.getByLabel('Code').fill(code);
  await member.getByRole('button', { name: 'Anmelden' }).click();
  await member.getByRole('button', { name: 'Profil', exact: true }).click();
  await expect(member.getByRole('heading', { name: 'Dein Profil' })).toBeVisible();
  await expect(member.getByText('Nicht öffentlich: Du hast keine Profilart gewählt.')).toBeVisible();
  await member.getByLabel('Über Dich').fill('Spielt Tennis und hilft beim Sommerfest.');
  await member.getByRole('button', { name: 'Link hinzufügen' }).click();
  await member.getByLabel('Bezeichnung').fill('Website');
  await member.getByLabel('Adresse').fill('https://pia.example');
  await member.getByRole('button', { name: 'Speichern' }).click();
  await expect(member.getByText('Gespeichert.')).toBeVisible();
  await member.reload();
  await expect(member.getByLabel('Über Dich')).toHaveValue('Spielt Tennis und hilft beim Sommerfest.');
  await expect(member.getByLabel('Adresse')).toHaveValue('https://pia.example');
});
