import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

test('offline attendance: marks taken without signal wait on the device and arrive when the connection is back', async ({ page, context }) => {
  await signIn(page);
  const post = (url: string, data: unknown) => page.request.post(url, { headers: { 'idempotency-key': randomUUID() }, data });
  const cal = await (await post('/api/v1/calendars', { name: 'Hallentraining' })).json();
  const day = today();
  const created = await post('/api/v1/events', { calendarId: cal.id, title: 'Training ohne Netz', startsAt: `${day}T00:00`, endsAt: `${day}T23:59`, rsvp: false });
  expect(created.status(), await created.text()).toBe(201);
  const ev = await created.json();
  await post('/api/v1/members', { firstName: 'Ole', lastName: 'Offline', joinDate: '2024-01-01' });

  await page.goto(`/termine/${ev.eventId}/${day}`);
  const sheet = page.getByRole('dialog', { name: 'Training ohne Netz' });
  await sheet.getByLabel('Anwesende hinzufügen').fill('Offline');
  const row = sheet.getByRole('listitem').filter({ hasText: 'Offline, Ole' });
  await expect(row.getByRole('button', { name: 'Anwesend' })).toBeVisible();

  await context.setOffline(true);
  await row.getByRole('button', { name: 'Anwesend' }).click();
  await expect(sheet.getByRole('status')).toContainText('1 Eintrag wartet auf diesem Gerät');
  await expect(sheet.getByRole('listitem').filter({ hasText: 'Offline, Ole' })).toContainText('Anwesend');

  await context.setOffline(false);
  await expect(sheet.getByRole('status')).toHaveCount(0, { timeout: 15_000 });
  const detail = await (await page.request.get(`/api/v1/events/${ev.eventId}/occurrences/${day}`)).json();
  expect(detail.participants.map((p: { name: string; status: string }) => [p.name, p.status])).toEqual([[expect.stringContaining('Offline'), 'attended']]);
});
