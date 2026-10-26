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

  it('uses the limits of the year, keeps voided payments as evidence, and audits declarations with their old values', async () => {
    const t = (await admin.post('/members', { firstName: 'Olaf', lastName: 'Alt', joinDate: '2010-01-01' })).body;
    await admin.post('/allowances/payments', { personId: t.personId, kind: 'uebungsleiter', paidOn: '2020-12-01', amountCents: 300_000, text: 'Training 2020' });
    const y2020 = (await admin.get('/allowances?year=2020')).body;
    expect(y2020[0]).toMatchObject({ limitCents: 240_000, remainingCents: -60_000 });
    expect((await admin.get('/allowances?year=2012')).status).toBe(400);
    expect((await admin.post('/allowances/payments', { personId: t.personId, kind: 'ehrenamt', paidOn: '2012-05-01', amountCents: 100, text: 'Alt' })).status).toBe(400);

    const id = y2020[0].payments[0].id;
    expect((await admin.del(`/allowances/payments/${id}`)).status).toBe(204);
    expect((await admin.get('/allowances?year=2020')).body).toEqual([]);
    const kept = await ctx.db.selectFrom('allowance_payment').select(['voided_at', 'void_reason']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(kept.voided_at).not.toBeNull();
    await expect(ctx.db.deleteFrom('allowance_payment').where('id', '=', id).execute()).rejects.toThrow(/voided, not deleted/);

    await admin.put('/allowances/declarations', { personId: t.personId, year: 2026, kind: 'ehrenamt', otherCents: 10_000, declaredOn: '2026-01-10' });
    await admin.put('/allowances/declarations', { personId: t.personId, year: 2026, kind: 'ehrenamt', otherCents: 20_000, declaredOn: '2026-02-10' });
    const audits = await ctx.db.selectFrom('audit_event').select('diff').where('action', '=', 'allowance.declared').orderBy('id', 'desc').execute();
    expect((audits[0]!.diff as { otherCents: number[] }).otherCents).toEqual([10_000, 20_000]);
  });
});
