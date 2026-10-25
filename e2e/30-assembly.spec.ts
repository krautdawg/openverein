import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('general assembly: agenda, invitation, attendance, vote, close and minutes', async ({ page }) => {
  await signIn(page);
  // Self-contained: at least one member to mark present.
  await page.request.post('/api/v1/members', { headers: { 'idempotency-key': randomUUID() }, data: { firstName: 'Vera', lastName: 'Versammlung', joinDate: '2020-01-01' } });
  const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await page.goto('/versammlungen');
  await page.getByRole('button', { name: 'Versammlung anlegen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Versammlung anlegen' });
  await sheet.getByLabel('Datum').fill(day);
  await sheet.getByLabel('Ort').fill('Vereinsheim');
  await sheet.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page).toHaveURL(/\/versammlungen\/[0-9a-f-]+$/);

  await page.getByRole('button', { name: 'Einladung verschicken' }).click();
  await expect(page.getByText(/Verschickt am/)).toBeVisible();

  await page.getByRole('list', { name: 'Mitglieder' }).getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Anwesenheit speichern' }).click();
  await expect(page.getByText(/^1 von \d+ Mitgliedern anwesend\./)).toBeVisible();

  const vote = page.getByRole('form', { name: 'Ergebnis zu Entlastung des Vorstands' });
  await vote.getByLabel('Ja').fill('1');
  await vote.getByLabel('Nein').fill('0');
  await vote.getByLabel('Enthaltung').fill('0');
  await vote.getByLabel(/Beschluss oder Notiz/).fill('Der Vorstand ist entlastet.');
  await vote.getByRole('button', { name: 'Speichern' }).click();
  await expect(vote.getByRole('status')).toHaveText('Gespeichert.');

  await page.getByLabel('Versammlungsleitung').fill('Erika Mustermann');
  await page.getByLabel('Protokoll', { exact: true }).fill('Max Muster');
  await page.getByRole('button', { name: 'Versammlung abschließen' }).click();
  await expect(page.getByText(/Das Protokoll wird nicht mehr geändert/)).toBeVisible();
  const pdf = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Protokoll (PDF)' }).click();
  expect((await pdf).suggestedFilename()).toMatch(/^Protokoll-\d{4}-\d{2}-\d{2}\.pdf$/);
});

test('board meeting: invited group and its attendance list', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/groups', { headers: { 'idempotency-key': randomUUID() }, data: { name: `Vorstand ${Date.now()}`, shortCode: `V${Date.now() % 100000}`, kind: 'board' } });
  const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await page.goto('/versammlungen');
  await page.getByRole('button', { name: 'Versammlung anlegen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Versammlung anlegen' });
  await sheet.getByRole('button', { name: 'Vorstandssitzung' }).click();
  await expect(sheet.getByLabel('Titel')).toHaveValue('Vorstandssitzung');
  await sheet.getByLabel('Datum').fill(day);
  await sheet.getByLabel('Ort').fill('Online');
  await sheet.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByText(/^Vorstandssitzung · /)).toBeVisible();
  await expect(page.getByText(/an die eingeladene Gruppe/)).toBeVisible();
});
