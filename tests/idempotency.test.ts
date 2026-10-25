import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let cookie: string;
let memberId: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  memberId = (await ctx.app.inject({ method: 'POST', url: '/api/v1/members', headers: { cookie, 'idempotency-key': 'm-00000001' }, payload: { lastName: 'Zahler', joinDate: '2024-01-01' } })).json().id;
});

const createInvoice = (key?: string, unitCents = 6000) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) }, payload: { memberId, lines: [{ text: 'Beitrag', unitCents }] } });

describe('idempotency keys', () => {
  it('requires a key on money writes, replays the first response, and refuses a reused key for another body', async () => {
    expect((await createInvoice()).json().type).toContain('idempotency-key-required');
    const first = await createInvoice('retry-0001');
    expect(first.statusCode).toBe(201);
    const again = await createInvoice('retry-0001');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    expect(await ctx.db.selectFrom('invoice').select('id').execute()).toHaveLength(1);
    expect((await createInvoice('retry-0001', 7000)).statusCode).toBe(422);
  });

  it('frees the key after a failed attempt', async () => {
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { cookie, 'idempotency-key': 'retry-0002' }, payload: { memberId, lines: [] } });
    expect(bad.statusCode).toBe(400);
    expect((await createInvoice('retry-0002')).statusCode).toBe(201);
  });
});
