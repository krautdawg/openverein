import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let adminCookie: string;
let calendarId: string;
beforeEach(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
  calendarId = (await admin.post('/calendars', { name: 'Training', color: 'gruen' })).body.id;
});

const member = async (lastName: string, extra: Record<string, unknown> = {}) => (await admin.post('/members', { lastName, joinDate: '2024-01-01', ...extra })).body.id as string;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('events', () => {
  it('expands a weekly series, cancels one date and moves the following ones', async () => {
    const ev = await admin.post('/events', { calendarId, title: 'Training U17', startsAt: '2026-12-01T18:00', endsAt: '2026-12-01T19:30', recurrence: { freq: 'WEEKLY', byDay: ['TU', 'TH'], until: '2026-12-31' } });
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    const id = ev.body.eventId;
    expect((await admin.get('/events?from=2026-12-01&to=2026-12-31')).body).toHaveLength(10);
    expect((await admin.del(`/events/${id}`)).status).toBe(204); // removes the whole series
    const s = (await admin.post('/events', { calendarId, title: 'Training', startsAt: '2026-12-01T18:00', endsAt: '2026-12-01T19:30', recurrence: { freq: 'WEEKLY', byDay: ['TU', 'TH'], until: '2026-12-31' } })).body;
    await ctx.app.inject({ method: 'DELETE', url: `/api/v1/events/${s.eventId}`, headers: { cookie: adminCookie }, payload: { scope: 'this', date: '2026-12-24' } });
    const moved = await admin.patch(`/events/${s.eventId}`, { scope: 'following', date: '2026-12-15', startsAt: '2026-12-15T19:00', endsAt: '2026-12-15T20:30' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const list = (await admin.get('/events?from=2026-12-01&to=2026-12-31')).body as { date: string; startsAt: string }[];
    expect(list.map((o) => o.date)).toEqual(['2026-12-01', '2026-12-03', '2026-12-08', '2026-12-10', '2026-12-15', '2026-12-17', '2026-12-22', '2026-12-29', '2026-12-31']);
    expect(list.find((o) => o.date === '2026-12-10')!.startsAt).toBe('2026-12-10T18:00');
    expect(list.find((o) => o.date === '2026-12-17')!.startsAt).toBe('2026-12-17T19:00');
  });

  it('fills places, waitlists, promotes and bills paid events once', async () => {
    const d = future(10);
    const ev = (await admin.post('/events', { calendarId, title: 'Kletterkurs', startsAt: `${d}T10:00`, endsAt: `${d}T12:00`, maxParticipants: 2, priceCents: 4500 })).body;
    const [a, b, c] = [await member('Alpha'), await member('Beta'), await member('Gamma')];
    const put = (m: string, status: string) => admin.put(`/events/${ev.eventId}/occurrences/${d}/participants/${m}`, { status });
    await put(a, 'yes');
    await put(b, 'yes');
    const third = await put(c, 'yes');
    expect(third.status, JSON.stringify(third.body)).toBe(200);
    expect(third.body.participants.find((p: { memberId: string }) => p.memberId === c).status).toBe('waitlist');
    const after = await put(a, 'no');
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.participants.find((p: { memberId: string }) => p.memberId === c).status).toBe('yes');
    await put(a, 'maybe');
    const invoices = (await admin.get('/invoices?status=all')).body.items;
    expect(invoices.map((i: { totalCents: number }) => i.totalCents)).toEqual([4500, 4500, 4500]);
    await put(b, 'no');
    await put(b, 'yes');
    expect((await admin.get('/invoices?status=all')).body.total).toBe(3);
  });

  it('refuses attendance before the start and RSVPs after it', async () => {
    const d = future(3);
    const ev = (await admin.post('/events', { calendarId, title: 'Sitzung', startsAt: `${d}T19:00`, endsAt: `${d}T21:00` })).body;
    const m = await member('Delta');
    expect((await admin.put(`/events/${ev.eventId}/occurrences/${d}/participants/${m}`, { status: 'attended' })).status).toBe(409);
    const past = (await admin.post('/events', { calendarId, title: 'Gestern', startsAt: '2026-01-01T19:00', endsAt: '2026-01-01T21:00' })).body;
    expect((await admin.put(`/events/${past.eventId}/occurrences/2026-01-01/participants/${m}`, { status: 'yes' })).status).toBe(409);
    expect((await admin.put(`/events/${past.eventId}/occurrences/2026-01-01/participants/${m}`, { status: 'attended' })).body.counts.attended).toBe(1);
    expect((await admin.put(`/events/${past.eventId}/occurrences/2026-01-02/participants/${m}`, { status: 'attended' })).status).toBe(404);
  });

  it('serves an ICS feed through a secret link that can be rotated', async () => {
    await admin.post('/events', { calendarId, title: 'Training, Halle 2', startsAt: '2026-12-01T18:00', endsAt: '2026-12-01T19:30', recurrence: { freq: 'WEEKLY', until: '2026-12-31' } });
    const feed = (await admin.post(`/calendars/${calendarId}/feed`)).body.path as string;
    const res = await ctx.app.inject(feed);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.body).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261231');
    expect(res.body).toContain('DTSTART;TZID=Europe/Berlin:20261201T180000');
    expect(res.body).toContain('SUMMARY:Training\\, Halle 2');
    await admin.post(`/calendars/${calendarId}/feed`);
    expect((await ctx.app.inject(feed)).statusCode).toBe(404);
  });

  it('limits scoped trainers to calendars of their groups and hides birthdays without the right', async () => {
    const tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const board = (await admin.post('/calendars', { name: 'Vorstand', groupIds: [(await admin.post('/groups', { name: 'Vorstand', shortCode: 'VS' })).body.id] })).body.id;
    const tcal = (await admin.post('/calendars', { name: 'Tennis', groupIds: [tennis] })).body.id;
    await admin.post('/events', { calendarId: board, title: 'Vorstandssitzung', startsAt: '2026-12-02T19:00', endsAt: '2026-12-02T21:00' });
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Trainer:in', [tennis]) });
    expect((await trainer.get('/calendars')).body.map((c: { name: string }) => c.name).sort()).toEqual(['Tennis', 'Training']);
    expect((await trainer.get('/events?from=2026-12-01&to=2026-12-31')).body).toHaveLength(0);
    expect((await trainer.post(`/calendars/${board}/feed`, {})).status).toBe(403);
    const own = (await trainer.post('/events', { calendarId: tcal, title: 'Tennis', startsAt: '2026-12-03T17:00', endsAt: '2026-12-03T18:00' })).body;
    expect((await trainer.patch(`/events/${own.eventId}`, { calendarId })).status).toBe(403); // club-wide calendar
    await member('Geburtstag', { birthDate: '2000-12-05', groupIds: [tennis] });
    expect((await admin.get('/birthdays?from=2026-12-01&to=2026-12-31')).body[0]).toMatchObject({ date: '2026-12-05', age: 26 });
    const adviser = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Steuerberatung', null) });
    expect((await adviser.get('/birthdays?from=2026-12-01&to=2026-12-31')).body).toEqual([]);
  });

  it('review fixes: cancelling a paid date cancels its invoices, orphan series are refused, dates with RSVPs cannot vanish', async () => {
    const d = future(10);
    const ev = (await admin.post('/events', { calendarId, title: 'Kurs', startsAt: `${d}T10:00`, endsAt: `${d}T12:00`, priceCents: 2000 })).body;
    const a = await member('Alpha');
    await admin.put(`/events/${ev.eventId}/occurrences/${d}/participants/${a}`, { status: 'yes' });
    expect((await admin.del(`/events/${ev.eventId}`)).status).toBe(204);
    const inv = (await admin.get('/invoices?status=all')).body.items as { status: string; kind: string }[];
    expect(inv.map((i) => i.status).sort()).toEqual(['cancelled', 'issued']);

    const none = await admin.post('/events', { calendarId, title: 'Leer', startsAt: '2026-12-10T10:00', endsAt: '2026-12-10T11:00', recurrence: { freq: 'WEEKLY', until: '2026-12-01' } });
    expect(none.status).toBe(400);
    expect(await ctx.db.selectFrom('event').select('id').where('title', '=', 'Leer').execute()).toHaveLength(0);
    expect((await admin.post('/events', { calendarId, title: 'X', startsAt: '2026-02-30T10:00', endsAt: '2026-02-30T11:00' })).status).toBe(400);

    // A Monday-only series created on a Sunday starts on Monday.
    const mo = (await admin.post('/events', { calendarId, title: 'Montags', startsAt: '2026-12-06T18:00', endsAt: '2026-12-06T19:00', recurrence: { freq: 'WEEKLY', byDay: ['MO'] } })).body;
    expect(mo.seriesStart).toBe('2026-12-07');

    const s = (await admin.post('/events', { calendarId, title: 'Serie', startsAt: `${d}T18:00`, endsAt: `${d}T19:00`, recurrence: { freq: 'DAILY' } })).body;
    await admin.put(`/events/${s.eventId}/occurrences/${future(11)}/participants/${a}`, { status: 'yes' });
    const shifted = await admin.patch(`/events/${s.eventId}`, { scope: 'all', recurrence: { freq: 'WEEKLY', interval: 2 } });
    expect(shifted.status).toBe(409);
    // "following" from the first date edits the whole series instead of leaving an empty one behind.
    const whole = await admin.patch(`/events/${s.eventId}`, { scope: 'following', date: d, title: 'Serie neu' });
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(whole.body.eventId).toBe(s.eventId);
  });

  it('does not promote from the waitlist when attendance is recorded', async () => {
    const d = future(0);
    const ev = (await admin.post('/events', { calendarId, title: 'Jetzt', startsAt: `${d}T00:00`, endsAt: `${d}T23:59`, maxParticipants: 1, priceCents: 1000 })).body;
    const [a, b] = [await member('Alpha'), await member('Beta')];
    await ctx.db.insertInto('participation').values([
      { organization_id: (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id, event_id: ev.eventId, occurrence_date: d, member_id: a, status: 'yes' },
      { organization_id: (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id, event_id: ev.eventId, occurrence_date: d, member_id: b, status: 'waitlist', waitlisted_at: new Date() },
    ]).execute();
    const r = await admin.put(`/events/${ev.eventId}/occurrences/${d}/participants/${a}`, { status: 'not_attended' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.participants.find((p: { memberId: string }) => p.memberId === b).status).toBe('waitlist');
  });

  it('publishes a calendar for the website without descriptions, only when public', async () => {
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await admin.post('/events', { calendarId, title: 'Probetraining', description: 'Intern: Schlüssel bei Jens', location: 'Halle 2', startsAt: `${day}T18:00`, endsAt: `${day}T19:30` });
    const pub = (url: string) => ctx.app.inject({ url: `/api/v1${url}` });
    expect((await pub(`/public/calendars/${calendarId}/events`)).statusCode).toBe(404);
    expect((await admin.patch(`/calendars/${calendarId}`, { publicOrigins: ['http://unsicher.example'] })).status).toBe(400);
    const on = await admin.patch(`/calendars/${calendarId}`, { public: true, publicOrigins: ['https://www.tsv.example'] });
    expect(on.body).toMatchObject({ public: true, publicOrigins: ['https://www.tsv.example'] });
    const res = await pub(`/public/calendars/${calendarId}/events`);
    expect(res.statusCode).toBe(200);
    expect(res.json().events[0]).toEqual({ title: 'Probetraining', date: day, startsAt: `${day}T18:00`, endsAt: `${day}T19:30`, allDay: false, location: 'Halle 2' });
    expect(res.body).not.toContain('Schlüssel');
    const board = (await admin.post('/groups', { name: 'Vorstand', shortCode: 'VS', kind: 'board' })).body.id;
    const internal = (await admin.post('/calendars', { name: 'Intern', groupIds: [board] })).body.id;
    expect((await admin.patch(`/calendars/${internal}`, { public: true })).status).toBe(409);
  });
});
