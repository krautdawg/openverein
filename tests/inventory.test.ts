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

describe('inventory', () => {
  it('lends no more than there is, marks overdue loans, and keeps lent items from being retired', async () => {
    const m = (await admin.post('/members', { lastName: 'Leiher', joinDate: '2020-01-01' })).body.id;
    const balls = (await admin.post('/inventory', { name: 'Fußball Größe 5', category: 'Bälle', location: 'Geräteraum', quantity: 3 })).body;
    expect(balls).toMatchObject({ available: 3, loans: [] });
    const lent = await admin.post(`/inventory/${balls.id}/loans`, { memberId: m, quantity: 2, lentOn: '2026-01-10', dueOn: '2026-01-20' });
    expect(lent.status, JSON.stringify(lent.body)).toBe(201);
    expect(lent.body).toMatchObject({ available: 1, loans: [{ memberName: 'Leiher', quantity: 2, overdue: true }] });
    expect((await admin.post(`/inventory/${balls.id}/loans`, { memberId: m, quantity: 2, lentOn: '2026-01-11' })).status).toBe(409);
    expect((await admin.put(`/inventory/${balls.id}`, { name: 'Fußball Größe 5', quantity: 3, archived: true })).status).toBe(409);
    const back = await admin.post(`/inventory/loans/${lent.body.loans[0].id}/return`, { returnedOn: '2026-01-19' });
    expect(back.body).toMatchObject({ available: 3, loans: [] });
    expect((await admin.put(`/inventory/${balls.id}`, { name: 'Fußball Größe 5', quantity: 3, archived: true })).body.archived).toBe(true);
    expect((await admin.get('/inventory')).body).toEqual([]);
  });

  it('keeps lending club-wide, refuses future dates, and counts a return once', async () => {
    const m = (await admin.post('/members', { lastName: 'Leiher', joinDate: '2020-01-01' })).body.id;
    const item = (await admin.post('/inventory', { name: 'Schlüssel Halle', quantity: 1 })).body;
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await admin.post(`/inventory/${item.id}/loans`, { memberId: m, lentOn: future })).status).toBe(400);
    const lent = (await admin.post(`/inventory/${item.id}/loans`, { memberId: m, lentOn: '2026-01-10' })).body;
    const loan = lent.loans[0].id;
    expect((await admin.post(`/inventory/loans/${loan}/return`, { returnedOn: future })).status).toBe(400);
    const group = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Abteilungsleitung', [group]) });
    expect((await lead.post(`/inventory/loans/${loan}/return`, { returnedOn: '2026-01-12' })).status).toBe(403);
    const [a, b] = await Promise.all([admin.post(`/inventory/loans/${loan}/return`, { returnedOn: '2026-01-12' }), admin.post(`/inventory/loans/${loan}/return`, { returnedOn: '2026-01-13' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});
