import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('events: calendar, weekly training, RSVP and cancelling one date', async ({ page }) => {
  await signIn(page);
  const m = await (await page.request.post('/api/v1/members', { data: { firstName: 'Tom', lastName: 'Training', joinDate: '2024-01-01' } })).json();
  await page.goto('/termine');
  await page.getByRole('button', { name: 'Kalender', exact: true }).click();
  const cal = page.getByRole('dialog', { name: 'Kalender' });
  await cal.getByLabel('Name').fill('Training');
  await cal.getByRole('button', { name: 'Kalender anlegen' }).click();
  await expect(cal.getByText('Für alle Mitglieder')).toBeVisible();
  await cal.getByRole('button', { name: 'Schließen' }).click();

  const next = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.getByRole('button', { name: 'Termin anlegen' }).click();
  const form = page.getByRole('dialog', { name: 'Termin anlegen' });
  await form.getByLabel('Titel').fill('Training U17');
  await form.getByLabel('Datum').fill(next);
  await form.getByLabel('Wiederholen').selectOption('weekly');
  await form.getByLabel('Höchstens Teilnehmende').fill('12');
  await form.getByRole('button', { name: 'Anlegen' }).click();

  const sheet = page.getByRole('dialog', { name: 'Training U17' });
  await expect(sheet.getByText('Serie')).toBeVisible();
  await sheet.getByLabel('Rückmeldung für ein Mitglied eintragen').fill('Training');
  await sheet.getByRole('button', { name: 'Zusage' }).click();
  await expect(sheet.getByText('1 von 12 belegt')).toBeVisible();

  await sheet.getByRole('button', { name: 'Termin absagen …' }).click();
  await sheet.getByRole('button', { name: 'Nur diesen' }).click();
  const list = await (await page.request.get(`/api/v1/events?from=${next}&to=${next}`)).json();
  expect(list).toHaveLength(0);
  void m;
});
