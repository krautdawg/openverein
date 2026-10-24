import { createHash } from 'node:crypto';
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
  await admin.patch('/organization', { street: 'Sportplatzweg 1', postalCode: '12345', city: 'Musterstadt', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', bankName: 'Musterbank' });
});

async function setup(opts: { join?: string; interval?: number | null; amount?: number } = {}) {
  const plan = await admin.post('/fee-plans', { name: 'Erwachsene', version: { validFrom: '2020-01-01', amountCents: opts.amount ?? 12000, intervalMonths: opts.interval === undefined ? 12 : opts.interval } });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  const m = await admin.post('/members', { firstName: 'Eva', lastName: 'Beispiel', street: 'Lindenweg 3', postalCode: '12345', city: 'Musterstadt', joinDate: opts.join ?? '2026-05-10' });
  await admin.patch(`/members/${m.body.id}/payment-method`, { paymentMethod: 'transfer' });
  const a = await admin.post(`/members/${m.body.id}/fee-assignments`, { feePlanId: plan.body.id, validFrom: opts.join ?? '2026-05-10' });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  return { planId: plan.body.id as string, memberId: m.body.id as string, assignmentId: a.body.id as string };
}

async function postRun(until = '2026-12-31', exclude: string[] = []) {
  const run = await admin.post('/fee-runs', { until, issueDate: '2026-06-01' });
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const posted = await admin.post(`/fee-runs/${run.body.id}/post`, { excludeLineKeys: exclude });
  return { run: run.body, posted };
}

describe('fee plans and assignments', () => {
  it('rejects a second main plan, intervals over 60 and a price before billed periods', async () => {
    const { planId, memberId } = await setup();
    const other = await admin.post('/fee-plans', { name: 'Familie', version: { validFrom: '2020-01-01', amountCents: 20000, intervalMonths: 12 } });
    const second = await admin.post(`/members/${memberId}/fee-assignments`, { feePlanId: other.body.id, validFrom: '2026-07-01' });
    expect(second.status).toBe(409);
    expect(second.body.detail).toContain('Hauptbeitrag');
    const addOn = await admin.post(`/members/${memberId}/fee-assignments`, { feePlanId: other.body.id, isMain: false, validFrom: '2026-07-01' });
    expect(addOn.status).toBe(201);
    expect((await admin.post('/fee-plans', { name: 'X', version: { validFrom: '2020-01-01', amountCents: 1, intervalMonths: 61 } })).status).toBe(400);
    expect((await admin.post('/fee-plans', { name: 'Zwei Jahre', version: { validFrom: '2020-01-01', amountCents: 1, intervalMonths: 24 } })).status).toBe(201);
    await postRun();
    expect((await admin.post(`/fee-plans/${planId}/versions`, { validFrom: '2026-06-01', amountCents: 14400, intervalMonths: 12 })).status).toBe(409);
    expect((await admin.post(`/fee-plans/${planId}/versions`, { validFrom: '2027-01-01', amountCents: 14400, intervalMonths: 12 })).status).toBe(201);
    expect((await admin.del(`/fee-plans/${planId}`)).status).toBe(409);
  });

  it('explains the fee without posting anything', async () => {
    const { memberId } = await setup();
    const calc = await admin.get(`/members/${memberId}/fee-calculator?until=2026-12-31`);
    expect(calc.body.totalCents).toBe(8000);
    expect(calc.body.lines[0].explanation).toContain('anteilig 8 von 12');
    expect((await ctx.db.selectFrom('assessment').selectAll().execute())).toHaveLength(0);
  });
});

describe('fee run', () => {
  it('previews, posts one invoice, and never bills the same period twice', async () => {
    await setup();
    const { run, posted } = await postRun();
    expect(run.status).toBe('preview');
    expect(run.members[0].warnings).toEqual([]);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.invoiceCount).toBe(1);
    const list = await admin.get('/invoices');
    expect(list.body.items[0]).toMatchObject({ number: 'R-2026-00001', status: 'open', totalCents: 8000, kind: 'membership' });

    const again = await admin.post('/fee-runs', { until: '2026-12-31' });
    expect(again.body.totals.lines).toBe(0);
    expect(again.body.members[0].skipped[0].reason).toContain('bereits berechnet');
    const posted2 = await admin.post(`/fee-runs/${again.body.id}/post`, {});
    expect(posted2.body.invoiceCount).toBe(0);
  });

  it('refuses to post a stale preview', async () => {
    const { assignmentId } = await setup();
    const run = await admin.post('/fee-runs', { until: '2026-12-31' });
    await ctx.db.updateTable('fee_assignment').set({ override_cents: 6000, override_reason: 'Ermäßigt' }).where('id', '=', assignmentId).execute();
    const posted = await admin.post(`/fee-runs/${run.body.id}/post`, {});
    expect(posted.status).toBe(409);
    expect(posted.body.title).toContain('seit der Vorschau');
    expect(await ctx.db.selectFrom('invoice').selectAll().execute()).toHaveLength(0);
  });

  it('lets the treasurer exclude catch-up lines and warns about missing payment methods', async () => {
    const plan = await admin.post('/fee-plans', { name: 'Monat', version: { validFrom: '2020-01-01', amountCents: 1000, intervalMonths: 1 } });
    const m = await admin.post('/members', { lastName: 'Spät', joinDate: '2026-02-01' });
    await admin.post(`/members/${m.body.id}/fee-assignments`, { feePlanId: plan.body.id, validFrom: '2026-02-01' });
    const run = await admin.post('/fee-runs', { until: '2027-06-30' });
    const p = run.body.members[0];
    expect(p.warnings).toContain('Keine Zahlungsart festgelegt.');
    const catchUp = p.lines.filter((l: { catchUp: boolean }) => l.catchUp);
    expect(catchUp.length).toBeGreaterThan(0);
    const posted = await admin.post(`/fee-runs/${run.body.id}/post`, { excludeLineKeys: catchUp.map((l: { key: string }) => l.key) });
    const inv = (await admin.get('/invoices')).body.items[0];
    expect(inv.totalCents).toBe((p.lines.length - catchUp.length) * 1000);
    expect(posted.status).toBe(200);
  });

  it('cancels a posted run with cancellation documents so the period can be billed again', async () => {
    await setup();
    const { posted } = await postRun();
    const cancel = await admin.post(`/fee-runs/${posted.body.id}/cancel`);
    expect(cancel.body.status).toBe('cancelled');
    const items = (await admin.get('/invoices')).body.items;
    expect(items.map((i: { number: string; status: string }) => [i.number, i.status]).sort()).toEqual([['R-2026-00001', 'cancelled'], ['S-2026-00001', 'issued']]);
    const again = await postRun();
    expect(again.posted.body.invoiceCount).toBe(1);
  });

  it('the database refuses an overlapping live assessment', async () => {
    const { memberId, assignmentId } = await setup();
    await postRun();
    const row = await ctx.db.selectFrom('assessment').selectAll().executeTakeFirstOrThrow();
    await expect(
      ctx.db.insertInto('assessment').values({ organization_id: row.organization_id, member_id: memberId, assignment_id: assignmentId, charge_slot: 'main', period_start: '2026-12-01', period_end: '2027-01-31', amount_cents: 1, snapshot: '{}' }).execute(),
    ).rejects.toThrow(/assessment_no_double_billing/);
  });
});

describe('invoices', () => {
  async function manual(memberId: string, unitCents = 2500) {
    const d = await admin.post('/invoices', { memberId, lines: [{ text: 'Trikot', quantity: 2, unitCents, taxRate: 19 }] });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    return d.body.id as string;
  }

  it('issues gapless numbers under concurrency and freezes issued invoices', async () => {
    const { memberId } = await setup();
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => manual(memberId)));
    const issued = await Promise.all(ids.map((id) => admin.post(`/invoices/${id}/issue`, {})));
    expect(issued.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(issued.map((r) => r.body.number).sort()).toEqual(['R-2026-00001', 'R-2026-00002', 'R-2026-00003', 'R-2026-00004', 'R-2026-00005'].map((n) => n.replace('2026', String(new Date().getFullYear()))));
    expect((await admin.patch(`/invoices/${ids[0]}`, { coverText: 'neu' })).status).toBe(409);
    await expect(ctx.db.updateTable('invoice').set({ total_cents: 1 }).where('id', '=', ids[0]!).execute()).rejects.toThrow(/immutable/);
    await expect(ctx.db.updateTable('invoice_line').set({ text: 'x' }).where('invoice_id', '=', ids[0]!).execute()).rejects.toThrow(/cannot change/);
  });

  it('records payments, refuses overpayment, reverses, and blocks cancelling a paid invoice', async () => {
    const { memberId } = await setup();
    const id = await manual(memberId);
    await admin.post(`/invoices/${id}/issue`, {});
    const over = await admin.post(`/invoices/${id}/payments`, { amountCents: 6000, bookedOn: '2026-06-02', method: 'cash' });
    expect(over.status).toBe(400);
    const part = await admin.post(`/invoices/${id}/payments`, { amountCents: 2000, bookedOn: '2026-06-02', method: 'cash' });
    expect(part.body).toMatchObject({ status: 'partially_paid', openCents: 3000 });
    expect((await admin.post(`/invoices/${id}/cancel`)).status).toBe(409);
    await admin.post(`/allocations/${part.body.allocations[0].id}/reverse`);
    expect((await admin.get(`/invoices/${id}`)).body.status).toBe('open');
    const full = await admin.post(`/invoices/${id}/payments`, { amountCents: 5000, bookedOn: '2026-06-03', method: 'transfer' });
    expect(full.body.status).toBe('paid');
  });

  it('stores the PDF once and returns the same bytes', async () => {
    const { memberId } = await setup();
    const id = await manual(memberId);
    await admin.post(`/invoices/${id}/issue`, {});
    const a = await ctx.app.inject({ url: `/api/v1/invoices/${id}/pdf`, headers: { cookie: adminCookie } });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toBe('application/pdf');
    expect(a.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    await admin.patch('/organization', { name: 'Ganz anderer Name e.V.' });
    const b = await ctx.app.inject({ url: `/api/v1/invoices/${id}/pdf`, headers: { cookie: adminCookie } });
    const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    expect(sha(b.rawPayload)).toBe(sha(a.rawPayload));
    expect((await admin.get(`/invoices/${id}`)).body.pdfSha256).toBe(sha(a.rawPayload));
  });

  it('proposes and applies dunning with a separate fee invoice, respects holds, and writes off', async () => {
    const { memberId } = await setup();
    const id = await manual(memberId);
    await admin.post(`/invoices/${id}/issue`, { issueDate: '2026-01-01' });
    await ctx.db.updateTable('organization').set({ dunning_levels: JSON.stringify([{ level: 1, label: 'Zahlungserinnerung', days: 14, feeCents: 0 }, { level: 2, label: '1. Mahnung', days: 28, feeCents: 500 }]) as never }).execute();
    let proposal = (await admin.get('/dunning/proposal')).body;
    expect(proposal).toHaveLength(1);
    expect(proposal[0].nextLevel).toBe(1);
    await admin.post(`/invoices/${id}/dunning`, { level: 1 });
    const second = await admin.post(`/invoices/${id}/dunning`, { level: 2 });
    expect(second.body.dunning.map((d: { level: number }) => d.level)).toEqual([1, 2]);
    expect(second.body.totalCents).toBe(5000);
    const fee = (await admin.get('/invoices?status=open')).body.items.find((i: { kind: string }) => i.kind === 'dunning_fee');
    expect(fee.totalCents).toBe(500);
    await admin.post(`/invoices/${fee.id}/dunning-hold`, { until: '2099-01-01', reason: 'Ratenzahlung' });
    proposal = (await admin.get('/dunning/proposal')).body;
    expect(proposal.find((p: { invoice: { id: string } }) => p.invoice.id === fee.id)).toBeUndefined();
    const off = await admin.post(`/invoices/${id}/write-off`, { reason: 'Mitglied verzogen, unbekannt' });
    expect(off.body).toMatchObject({ status: 'written_off', openCents: 0 });
    const wo = off.body.allocations.find((a: { method: string }) => a.method === 'write_off');
    await admin.post(`/allocations/${wo.id}/reverse`);
    expect((await admin.get(`/invoices/${id}`)).body.status).toBe('open');
  });

  it('trainers cannot see invoices', async () => {
    await setup();
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Trainer:in', null) });
    expect((await trainer.get('/invoices')).status).toBe(403);
    expect((await trainer.get('/fee-plans')).status).toBe(403);
  });
});

