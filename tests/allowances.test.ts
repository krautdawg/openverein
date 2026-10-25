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

describe('volunteer allowances', () => {
  it('sums payments per person and kind, counts declared other use, and warns past the limit', async () => {
    const t = (await admin.post('/members', { firstName: 'Tina', lastName: 'Trainerin', joinDate: '2020-01-01' })).body;
    const p1 = await admin.post('/allowances/payments', { personId: t.personId, kind: 'uebungsleiter', paidOn: '2026-03-31', amountCents: 150_000, text: 'Training Q1' });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    expect(p1.body.warning).toBeNull();
    await admin.put('/allowances/declarations', { personId: t.personId, year: 2026, kind: 'uebungsleiter', otherCents: 100_000, declaredOn: '2026-01-10' });
    const p2 = await admin.post('/allowances/payments', { personId: t.personId, kind: 'uebungsleiter', paidOn: '2026-06-30', amountCents: 100_000, text: 'Training Q2' });
    expect(p2.body.row).toMatchObject({ paidCents: 250_000, otherCents: 100_000, limitCents: 330_000, remainingCents: -20_000 });
    expect(p2.body.warning).toContain('überschritten');
    await admin.post('/allowances/payments', { personId: t.personId, kind: 'ehrenamt', paidOn: '2025-12-01', amountCents: 50_000, text: 'Platzwart 2025' });
    const y = (await admin.get('/allowances?year=2026')).body;
    expect(y).toHaveLength(1);
    expect((await admin.get('/allowances?year=2025')).body[0]).toMatchObject({ kind: 'ehrenamt', limitCents: 84_000, remainingCents: 34_000 });
    expect((await admin.del(`/allowances/payments/${y[0].payments[1].id}`)).status).toBe(204);
    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Abteilungsleitung', null) });
    expect((await lead.get('/allowances?year=2026')).status).toBe(403);
  });
});
