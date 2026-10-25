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

describe('census (Bestandserhebung)', () => {
  it('counts members on 1 January by age bracket and gender, per division, and only for club-wide readers', async () => {
    const tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
    await admin.post('/members', { lastName: 'Jung', gender: 'female', birthDate: '2010-05-01', joinDate: '2020-01-01', groupIds: [tennis] });
    await admin.post('/members', { lastName: 'Alt', gender: 'male', birthDate: '1980-12-31', joinDate: '2019-03-01' });
    await admin.post('/members', { lastName: 'Ohne', joinDate: '2021-01-01' });
    await admin.post('/members', { lastName: 'Spaeter', gender: 'female', birthDate: '1990-01-01', joinDate: '2027-02-01' });
    const gone = (await admin.post('/members', { lastName: 'Weg', gender: 'male', birthDate: '1990-01-01', joinDate: '2015-01-01' })).body;
    await admin.post(`/members/${gone.id}/resign`, { noticeDate: '2026-01-01', exitDate: '2026-06-30' });

    const res = await admin.get('/reports/census?year=2027');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [all, div] = res.body.rows;
    expect(all).toMatchObject({ name: 'Verein gesamt', total: 3, noBirthDate: 1 });
    expect(all.counts['15–18'].female).toBe(1);
    expect(all.counts['41–60'].male).toBe(1);
    expect(div).toMatchObject({ name: 'Tennis', total: 1 });
    expect(div.counts['15–18'].female).toBe(1);

    const csv = await ctx.app.inject({ url: '/api/v1/reports/census.csv?year=2027', headers: { cookie } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[1]).toMatch(/^Verein gesamt;/);

    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Abteilungsleitung', [tennis]) });
    expect((await lead.get('/reports/census?year=2027')).status).toBe(403);
  });
});
