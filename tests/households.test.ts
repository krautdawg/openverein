import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let adminCookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt' });
});

async function familyMember(planId: string, firstName: string, birthDate: string) {
  const m = (await admin.post('/members', { firstName, lastName: 'Familie', birthDate, street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2026-01-01' })).body;
  await admin.patch(`/members/${m.id}/payment-method`, { paymentMethod: 'transfer' });
  await admin.post(`/members/${m.id}/fee-assignments`, { feePlanId: planId, validFrom: '2026-01-01' });
  return m;
}

describe('households', () => {
  it('bills a household on one invoice to the payer with a discount line, and refuses to drop the payer', async () => {
    const adults = (await admin.post('/fee-plans', { name: 'Erwachsene', version: { validFrom: '2020-01-01', amountCents: 12000, intervalMonths: 12 } })).body.id;
    const kids = (await admin.post('/fee-plans', { name: 'Kinder', version: { validFrom: '2020-01-01', amountCents: 6000, intervalMonths: 12 } })).body.id;
    const mum = await familyMember(adults, 'Mara', '1984-03-01');
    const kid1 = await familyMember(kids, 'Kim', '2014-05-01');
    const kid2 = await familyMember(kids, 'Kai', '2017-07-01');
    const single = await familyMember(adults, 'Solo', '1990-01-01');
    const hh = await admin.post('/households', { name: 'Familie', payerPersonId: mum.personId, memberIds: [mum.id, kid1.id, kid2.id] });
    expect(hh.status, JSON.stringify(hh.body)).toBe(201);
    await admin.post(`/households/${hh.body.id}/rules`, { validFrom: '2026-01-01', kind: 'percent', fromNth: 2, percentBp: 5000 });
    expect((await admin.post('/households', { name: 'Zweit', payerPersonId: single.personId, memberIds: [kid1.id] })).status).toBe(409);

    const run = await admin.post('/fee-runs', { until: '2026-12-31', issueDate: '2026-02-01' });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.households).toEqual([expect.objectContaining({ name: 'Familie', discountCents: 6000, label: 'Familienrabatt 50 % ab dem 2. Mitglied' })]);
    expect(run.body.totals.totalCents).toBe(12000 + 6000 + 6000 + 12000 - 6000);
    expect((await admin.post(`/fee-runs/${run.body.id}/post`, {})).status).toBe(200);

    const invoices = (await admin.get('/invoices?limit=50')).body.items as { id: string; recipientName: string; totalCents: number }[];
    expect(invoices).toHaveLength(2);
    const family = invoices.find((i) => i.totalCents === 18000)!;
    const detail = (await admin.get(`/invoices/${family.id}`)).body;
    expect(detail.lines.map((l: { text: string; totalCents: number }) => l.totalCents)).toEqual([6000, 6000, 12000, -6000]);
    expect(detail.lines[0].text).toMatch(/^Familie, Kai: /);
    expect(detail.lines[3].text).toBe('Familienrabatt 50 % ab dem 2. Mitglied');

    expect((await admin.patch(`/households/${hh.body.id}`, { memberIds: [kid1.id, kid2.id] })).body.type).toContain('payer-removed');
    expect((await admin.patch(`/households/${hh.body.id}`, { memberIds: [kid1.id, kid2.id], payerPersonId: single.personId })).status).toBe(200);
  });

  it('marks a stored preview stale when the household changes', async () => {
    const plan = (await admin.post('/fee-plans', { name: 'Erwachsene', version: { validFrom: '2020-01-01', amountCents: 12000, intervalMonths: 12 } })).body.id;
    const a = await familyMember(plan, 'Anna', '1980-01-01');
    const b = await familyMember(plan, 'Ben', '1981-01-01');
    const hh = (await admin.post('/households', { name: 'Paar', payerPersonId: a.personId, memberIds: [a.id, b.id] })).body;
    const run = (await admin.post('/fee-runs', { until: '2026-12-31', issueDate: '2026-02-01' })).body;
    await admin.post(`/households/${hh.id}/rules`, { validFrom: '2026-01-01', kind: 'cap', capCents: 20000 });
    expect((await admin.post(`/fee-runs/${run.id}/post`, {})).body.type).toContain('stale-preview');
  });

  it('bills the whole household in a group run, notices in-place rule edits, and collects with the payer mandate', async () => {
    const plan = (await admin.post('/fee-plans', { name: 'Erwachsene', version: { validFrom: '2020-01-01', amountCents: 12000, intervalMonths: 12 } })).body.id;
    const youth = (await admin.post('/groups', { name: 'Jugend', shortCode: 'JUG' })).body.id;
    const parent = await familyMember(plan, 'Paula', '1980-01-01');
    const child = (await admin.post('/members', { firstName: 'Carl', lastName: 'Familie', birthDate: '2014-01-01', joinDate: '2026-01-01', groupIds: [youth] })).body;
    await admin.post(`/members/${child.id}/fee-assignments`, { feePlanId: plan, validFrom: '2026-01-01' });
    await admin.patch('/organization', { creditorId: 'DE98ZZZ09999999999' });
    await admin.post(`/members/${parent.id}/mandates`, { iban: 'DE02120300000000202051', signedOn: '2026-01-01', accountHolder: 'Paula Familie' });
    const hh = (await admin.post('/households', { name: 'Fam', payerPersonId: parent.personId, memberIds: [parent.id, child.id] })).body;
    await admin.post(`/households/${hh.id}/rules`, { validFrom: '2026-01-01', kind: 'percent', fromNth: 2, percentBp: 5000 });

    const run = (await admin.post('/fee-runs', { until: '2026-12-31', issueDate: '2026-02-01', groupId: youth })).body;
    expect(run.members.map((m: { name: string }) => m.name).sort()).toEqual(['Familie, Carl', 'Familie, Paula']);
    expect(run.households[0].discountCents).toBe(6000);
    // Same validFrom, other percentage: the stored preview is stale.
    await admin.post(`/households/${hh.id}/rules`, { validFrom: '2026-01-01', kind: 'percent', fromNth: 2, percentBp: 2500 });
    expect((await admin.post(`/fee-runs/${run.id}/post`, {})).body.type).toContain('stale-preview');
    const fresh = (await admin.post('/fee-runs', { until: '2026-12-31', issueDate: '2026-02-01' })).body;
    expect((await admin.post(`/fee-runs/${fresh.id}/post`, {})).status).toBe(200);
    const inv = (await ctx.db.selectFrom('invoice').select('recipient').where('kind', '=', 'membership').executeTakeFirstOrThrow()).recipient as { paymentMethod: string; mandateReference: string | null };
    expect(inv.paymentMethod).toBe('direct_debit');
    expect(inv.mandateReference).toBeTruthy();
    // The payer pays her own fees by transfer, but the household invoice was announced as a debit from her mandate:
    // the collection run takes it (candidates and the run's re-check follow the same rule).
    const candidates = (await admin.get('/collection-runs/candidates')).body as { readiness: string; number: string }[];
    expect(candidates.map((c) => c.readiness)).toEqual(['ok']);
  });

  it('puts the payer\'s own membership on the household invoice even when the payer is not billed, never a child\'s method', async () => {
    const kids = (await admin.post('/fee-plans', { name: 'Kinder', version: { validFrom: '2020-01-01', amountCents: 6000, intervalMonths: 12 } })).body.id;
    // The payer is a member without a fee in this run; the child is set to direct debit but there is no mandate.
    const payer = (await admin.post('/members', { firstName: 'Pia', lastName: 'Familie', birthDate: '1980-01-01', street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', joinDate: '2026-01-01' })).body;
    await admin.patch(`/members/${payer.id}/payment-method`, { paymentMethod: 'transfer' });
    const kid = await familyMember(kids, 'Kim', '2014-05-01');
    await ctx.db.updateTable('member').set({ payment_method: 'direct_debit' }).where('id', '=', kid.id).execute();
    const hh = (await admin.post('/households', { name: 'Familie', payerPersonId: payer.personId, memberIds: [payer.id, kid.id] })).body;
    const run = (await admin.post('/fee-runs', { until: '2026-12-31', issueDate: '2026-02-01' })).body;
    expect((await admin.post(`/fee-runs/${run.id}/post`, {})).status).toBe(200);
    const inv = await ctx.db.selectFrom('invoice').select(['member_id', 'recipient', 'recipient_person_id']).executeTakeFirstOrThrow();
    expect(inv.recipient_person_id).toBe(payer.personId);
    expect(inv.member_id).toBe(payer.id);
    expect((inv.recipient as { paymentMethod: string; membershipNumber: string }).paymentMethod).toBe('transfer');
    expect((inv.recipient as { membershipNumber: string }).membershipNumber).toBe(payer.membershipNumber);

    // Dissolving a household changes billing: it needs fee rights like every other household change.
    const perms = (await admin.get('/roles')).body.find((r: { name: string }) => r.name === 'Admin').permissions as Record<string, string>;
    await admin.post('/roles', { name: 'Mitgliederpflege', permissions: { ...Object.fromEntries(Object.keys(perms).map((m) => [m, 'read'])), members: 'write' } });
    const clerk = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Mitgliederpflege') });
    expect((await clerk.del(`/households/${hh.id}`)).status).toBe(403);
    expect((await admin.del(`/households/${hh.id}`)).status).toBe(204);
  });
});
