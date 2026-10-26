import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
});
const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) => ctx.app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers, ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, ...(payload ? { payload } : {}) });

describe('optimistic concurrency', () => {
  it('refuses a member change based on an outdated version and accepts the current one', async () => {
    const m = (await req('POST', '/members', { lastName: 'Version', joinDate: '2024-01-01' })).json();
    const read = await req('GET', `/members/${m.id}`);
    const etag = read.headers.etag as string;
    expect(etag).toBe(`"${read.json().version}"`);
    // Without If-Match there is no write at all.
    expect((await req('PATCH', `/members/${m.id}`, { city: 'Musterstadt' })).statusCode).toBe(428);
    // Someone else changes the record (no pause: two writes in the same millisecond still get new versions) …
    expect((await req('PATCH', `/members/${m.id}`, { city: 'Musterstadt' }, { 'if-match': etag })).statusCode).toBe(200);
    // … so the first editor's write is refused.
    const stale = await req('PATCH', `/members/${m.id}`, { city: 'Anderswo' }, { 'if-match': etag });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().type).toContain('stale');
    const fresh = (await req('GET', `/members/${m.id}`)).headers.etag as string;
    expect((await req('PATCH', `/members/${m.id}`, { city: 'Anderswo' }, { 'if-match': fresh })).statusCode).toBe(200);
  });

  it('protects club settings and invoice drafts the same way', async () => {
    const org = (await req('GET', '/organization')).json();
    await req('PATCH', '/organization', { city: 'Neu' }, { 'if-match': `"${org.version}"` });
    expect((await req('PATCH', '/organization', { city: 'Alt' }, { 'if-match': `"${org.version}"` })).statusCode).toBe(412);
    const m = (await req('POST', '/members', { lastName: 'Rechnung', joinDate: '2024-01-01' })).json();
    const draft = (await req('POST', '/invoices', { memberId: m.id, lines: [{ text: 'A', unitCents: 100 }] })).json();
    await req('PATCH', `/invoices/${draft.id}`, { coverText: 'neu' }, { 'if-match': `"${draft.version}"` });
    expect((await req('PATCH', `/invoices/${draft.id}`, { coverText: 'alt' }, { 'if-match': `"${draft.version}"` })).statusCode).toBe(412);
  });
});
