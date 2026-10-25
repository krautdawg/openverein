import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
let acc: (n: string) => string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  const accounts = (await admin.get('/ledger/accounts')).body as { id: string; number: string }[];
  acc = (n) => accounts.find((a) => a.number === n)!.id;
});

describe('budget', () => {
  it('compares planned and booked net amounts per account', async () => {
    await admin.post('/ledger/bookings', { kind: 'income', date: '2026-02-01', text: 'Zuschuss', moneyAccountId: acc('1100'), lines: [{ grossCents: 50000, accountId: acc('4600') }] });
    await admin.post('/ledger/bookings', { kind: 'expense', date: '2026-02-02', text: 'Bälle', moneyAccountId: acc('1100'), lines: [{ grossCents: 12000, accountId: acc('6100') }] });
    const set = await admin.put('/ledger/budget', { year: 2026, lines: [{ accountId: acc('4600'), plannedCents: 40000 }, { accountId: acc('6100'), plannedCents: 15000 }] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const rows = Object.fromEntries((set.body as { number: string }[]).map((r) => [r.number, r]));
    expect(rows['4600']).toMatchObject({ kind: 'income', plannedCents: 40000, actualCents: 50000 });
    expect(rows['6100']).toMatchObject({ kind: 'expense', plannedCents: 15000, actualCents: 12000 });
    expect((await admin.put('/ledger/budget', { year: 2026, lines: [{ accountId: acc('1100'), plannedCents: 1 }] })).status).toBe(400);
    const cleared = (await admin.put('/ledger/budget', { year: 2026, lines: [{ accountId: acc('6100'), plannedCents: null }] })).body as { number: string; plannedCents: number | null }[];
    expect(cleared.find((r) => r.number === '6100')!.plannedCents).toBeNull();
    const auditor = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Kassenprüfung', null) });
    expect((await auditor.get('/ledger/budget?year=2026')).status).toBe(200);
    expect((await auditor.put('/ledger/budget', { year: 2026, lines: [{ accountId: acc('4600'), plannedCents: 1 }] })).status).toBe(403);
  });
});
