import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
});

describe('work hours', () => {
  it('tracks hours against the rule, lets division leads log for their division, and bills missing hours once', async () => {
    expect((await admin.put('/work-hours/settings', { required: 10, rateCents: 1500, ageFrom: 18, ageTo: 65 })).status).toBe(200);
    const tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
    const fb = (await admin.post('/groups', { name: 'Fußball', shortCode: 'FB', kind: 'division' })).body.id;
    const a = (await admin.post('/members', { lastName: 'Fleissig', birthDate: '1980-01-01', joinDate: '2020-01-01', groupIds: [tennis] })).body.id;
    const b = (await admin.post('/members', { lastName: 'Faul', birthDate: '1985-01-01', joinDate: '2020-01-01', groupIds: [fb] })).body.id;
    await admin.post('/members', { lastName: 'Kind', birthDate: '2015-01-01', joinDate: '2020-01-01', groupIds: [tennis] });

    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Abteilungsleitung', [tennis]) });
    expect((await lead.post('/work-hours/entries', { memberId: a, workedOn: '2026-05-01', hours: 10, text: 'Platzpflege' })).status).toBe(201);
    expect((await lead.post('/work-hours/entries', { memberId: b, workedOn: '2026-05-01', hours: 2, text: 'Fremd' })).status).not.toBe(201);
    await admin.post('/work-hours/entries', { memberId: b, workedOn: '2026-06-01', hours: 7.5, text: 'Vereinsfest' });

    const year = (await admin.get('/work-hours?year=2026')).body;
    const byName = Object.fromEntries(year.members.map((m: { name: string }) => [m.name, m]));
    expect(byName.Fleissig).toMatchObject({ required: 10, done: 10, missing: 0, feeCents: 0 });
    expect(byName.Faul).toMatchObject({ required: 10, done: 7.5, missing: 2.5, feeCents: 3750 });
    expect(byName.Kind).toMatchObject({ required: 0, missing: 0 });

    const settle = await admin.post('/work-hours/settle', { year: 2026 });
    expect(settle.body).toEqual({ drafted: 1, alreadySettled: 0 });
    expect((await admin.post('/work-hours/settle', { year: 2026 })).body).toEqual({ drafted: 0, alreadySettled: 1 });
    const inv = (await admin.get(`/invoices/${(await admin.get('/work-hours?year=2026')).body.members.find((m: { name: string }) => m.name === 'Faul').invoiceId}`)).body;
    expect(inv.status).toBe('draft');
    expect(inv.lines[0]).toMatchObject({ quantity: 2.5, unitCents: 1500, totalCents: 3750 });
    // Settled years keep their hours.
    const entries = (await admin.get(`/work-hours/entries?memberId=${b}&year=2026`)).body;
    expect((await admin.del(`/work-hours/entries/${entries[0].id}`)).status).toBe(409);
  });
});
