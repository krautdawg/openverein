import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('applications: public form, board accepts, member exists', async ({ page }) => {
  await signIn(page);
  const slug = `mitmachen-${Date.now()}`;
  const group = await (await page.request.post('/api/v1/groups', { data: { name: `Yoga ${Date.now() % 1000}`, shortCode: `Y${Date.now() % 1000}` } })).json();
  const form = await page.request.post('/api/v1/application-forms', { data: { slug, title: 'Mitglied werden', groupIds: [group.id], consentText: 'Ich erkenne die Satzung an.', askMandate: false } });
  expect(form.ok()).toBe(true);

  await page.goto(`/aufnahme/${slug}`);
  await expect(page.getByRole('heading', { name: 'Mitglied werden' })).toBeVisible();
  await page.getByLabel('Vorname').fill('Ada');
  await page.getByLabel('Nachname').fill('Antrag');
  await page.getByLabel('Geburtsdatum').fill('1990-02-03');
  await page.getByLabel('E-Mail').fill(`ada-${Date.now()}@example.org`);
  await page.getByLabel('Straße und Hausnummer').fill('Weg 1');
  await page.getByLabel('Postleitzahl').fill('12345');
  await page.getByLabel('Ort').fill('Musterstadt');
  await page.getByLabel(group.name).check();
  await page.getByLabel(/Satzung/).check();
  await page.waitForTimeout(3100); // forms filled in under three seconds count as bots
  await page.getByRole('button', { name: 'Antrag abschicken' }).click();
  await expect(page.getByRole('heading', { name: 'Danke!' })).toBeVisible();

  await page.goto('/antraege');
  await page.getByRole('row', { name: /Antrag, Ada/ }).click();
  await page.getByRole('dialog', { name: 'Ada Antrag' }).getByRole('button', { name: 'Aufnehmen' }).click();
  await expect(page).toHaveURL(/\/mitglieder\/[0-9a-f-]+$/);
  await expect(page.getByRole('dialog').getByText('Antrag, Ada').or(page.getByRole('dialog').getByRole('heading', { name: /Ada/ }))).toBeVisible();
});
