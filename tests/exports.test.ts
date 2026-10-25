import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp } from './helpers.ts';

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

/** Reads all files of a ZIP produced by our writer (local headers in order). */
function unzip(buf: Buffer) {
  const out: Record<string, string> = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString();
    out[name] = new TextDecoder('windows-1252').decode(inflateRawSync(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + size)));
    o += 30 + nameLen + size;
  }
  return out;
}

describe('exports', () => {
  it('refuses DATEV without settings and mapping, then exports a delta once', async () => {
    await admin.post('/ledger/bookings', { kind: 'income', date: '2026-03-05', text: 'Spende Bäckerei', moneyAccountId: acc('1100'), lines: [{ grossCents: 25000, accountId: acc('4100') }] });
    const run = () => admin.post('/ledger/exports/datev', { from: '2026-01-01', to: '2026-03-31' });
    expect((await run()).body.type).toContain('datev-settings');
    await admin.put('/ledger/datev-settings', { consultant: 1001, client: 1, accountLength: 4, fiscalYearStartMonth: 1 });
    const missing = await run();
    expect(missing.status).toBe(409);
    expect(missing.body.accounts).toEqual(['1100 Bank', '4100 Spenden']);
    await admin.patch(`/ledger/accounts/${acc('1100')}`, { datevNumber: '1800' });
    await admin.patch(`/ledger/accounts/${acc('4100')}`, { datevNumber: '2250' });
    const ok = await run();
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const file = await ctx.app.inject({ url: `/api/v1/ledger/exports/${ok.body.id}/file`, headers: { cookie } });
    const csv = Object.values(unzip(file.rawPayload))[0]!;
    expect(csv.split('\r\n')[2]).toContain('250,00;"S";"EUR";;;;1800;2250;;0503;"1";;;"Spende Bäckerei"');
    expect((await run()).body.type).toContain('nothing'); // delta: nothing new
    expect((await admin.post('/ledger/exports/datev', { from: '2026-01-01', to: '2026-03-31', mode: 'full' })).status).toBe(201);
    // One batch, one fiscal year; parallel delta exports never repeat entries.
    expect((await admin.post('/ledger/exports/datev', { from: '2025-12-01', to: '2026-01-31' })).status).toBe(400);
    await admin.post('/ledger/bookings', { kind: 'income', date: '2026-03-06', text: 'Spende 2', moneyAccountId: acc('1100'), lines: [{ grossCents: 1000, accountId: acc('4100') }] });
    const both = await Promise.all([run(), run()]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('builds the tax-audit package with index.xml and tables, and logs the access', async () => {
    await admin.post('/ledger/bookings', { kind: 'expense', date: '2026-04-01', text: 'Hallenmiete', moneyAccountId: acc('1100'), lines: [{ grossCents: 48000, accountId: acc('6200') }] });
    const res = await ctx.app.inject({ url: '/api/v1/ledger/exports/z3?year=2026', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const files = unzip(res.rawPayload);
    expect(Object.keys(files).sort()).toEqual(['buchungen.csv', 'buchungszeilen.csv', 'debitoren.csv', 'index.xml', 'konten.csv', 'rechnungen.csv']);
    expect(files['index.xml']).toContain('<URL>buchungszeilen.csv</URL>');
    expect(files['buchungen.csv']).toContain('1;"01.04.2026";"Hallenmiete";"manual";');
    expect(files['buchungszeilen.csv']!.split('\r\n')[0]).toMatch(/^1;1;"1100";0,00;480,00;/);
    const log = await ctx.db.selectFrom('audit_event').select('action').where('action', '=', 'ledger.z3_export').execute();
    expect(log).toHaveLength(1);
  });
});
