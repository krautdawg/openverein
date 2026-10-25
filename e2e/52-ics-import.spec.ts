import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('ics import: events from a calendar file land in a club calendar', async ({ page }) => {
  await signIn(page);
  await page.request.post('/api/v1/calendars', { headers: { 'idempotency-key': randomUUID() }, data: { name: 'Hallenbelegung' } });
  await page.goto('/termine');
  await page.getByRole('button', { name: 'Kalender', exact: true }).click();
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e2e-1\r\nDTSTART;VALUE=DATE:20261205\r\nSUMMARY:Weihnachtsfeier\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  await page.getByLabel('ICS-Datei in Hallenbelegung importieren').setInputFiles({ name: 'hallen.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await expect(page.getByRole('status').filter({ hasText: 'übernommen' })).toContainText('Ein Termin übernommen');
});
