import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('calendar widget: a public calendar shows its dates on an embeddable page', async ({ page }) => {
  await signIn(page);
  const h = () => ({ 'idempotency-key': randomUUID() });
  const cal = await (await page.request.post('/api/v1/calendars', { headers: h(), data: { name: 'Öffentliche Termine' } })).json();
  const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  await page.request.post('/api/v1/events', { headers: h(), data: { calendarId: cal.id, title: 'Tag der offenen Tür', location: 'Sportplatz', startsAt: `${day}T10:00`, endsAt: `${day}T16:00` } });
  expect((await page.request.patch(`/api/v1/calendars/${cal.id}`, { data: { public: true, publicOrigins: ['https://www.tsv.example'] } })).ok()).toBe(true);

  const widget = await page.request.get(`/widget/termine/${cal.id}`);
  expect(widget.headers()['content-security-policy']).toBe("frame-ancestors 'self' https://www.tsv.example");
  await page.goto(`/widget/termine/${cal.id}`);
  await expect(page.getByRole('heading', { name: 'Öffentliche Termine' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Termine Öffentliche Termine' })).toContainText('Tag der offenen Tür');
});
