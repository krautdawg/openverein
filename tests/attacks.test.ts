import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { client, enrollTotp, reset, setupClub, testApp, userWithRole } from './helpers.ts';

/**
 * Permission attack suite: every GET route of the API is called with the ids of records a user must not see.
 * No response may carry the out-of-scope member's data, and no response may show an IBAN to a role without it.
 */
// The scan makes thousands of requests: lift the per-minute limit for this app instance.
config.rateLimitPerMinute = 1_000_000;
const ctx = await testApp();
afterAll(() => ctx.close());

const OUTSIDE = { lastName: 'Zzyzxfussball', email: 'zzyzx@example.org', iban: 'DE02120300000000202051' };
const INSIDE_IBAN = 'DE89370400440532013000';
let adminCookie: string;
let ids: string[] = [];
let insideIds: string[] = [];
let outsideMemberId: string;
let outsidePersonId: string;
let tennis: string;

beforeAll(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  const admin = client(ctx.app, { cookie: adminCookie });
  await admin.patch('/organization', { street: 'Platz 1', postalCode: '12345', city: 'Musterstadt', iban: 'DE75512108001245126199', creditorId: 'DE98ZZZ09999999999' });
  tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
  const football = (await admin.post('/groups', { name: 'Fußball', shortCode: 'FB', kind: 'division' })).body.id;
  const inside = (await admin.post('/members', { lastName: 'Innen', email: 'innen@example.org', street: 'Weg 2', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01', groupIds: [tennis] })).body;
  const outside = (await admin.post('/members', { firstName: 'Olga', lastName: OUTSIDE.lastName, email: OUTSIDE.email, phone: '0301234567', joinDate: '2024-01-01', groupIds: [football] })).body;
  expect(outside.id).toBeTruthy();
  await admin.post(`/members/${inside.id}/mandates`, { signedOn: '2024-01-01', accountHolder: 'Innen', iban: INSIDE_IBAN });
  // An e-invoiced direct debit: its XML carries the payer's full IBAN.
  await admin.patch('/organization', { email: 'kasse@example.org', vatId: 'DE123456789', einvoiceContactName: 'Erika Mustermann', einvoiceContactPhone: '+49 30 1234567' });
  expect((await admin.patch(`/members/${inside.id}/payment-method`, { paymentMethod: 'direct_debit' })).status).toBe(200);
  const patched = await admin.patch(`/members/${inside.id}`, { einvoiceFormat: 'xrechnung', buyerReference: '04011000-12345-67', einvoiceAddress: 'rechnung@innen.example' });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const einvoice = (await admin.post('/invoices', { memberId: inside.id, lines: [{ text: 'Hallennutzung', unitCents: 11900, taxRate: 19 }] })).body;
  const issuedE = await admin.post(`/invoices/${einvoice.id}/issue`, {});
  expect(issuedE.status, JSON.stringify(issuedE.body)).toBe(200);
  const xml = await ctx.app.inject({ url: `/api/v1/invoices/${einvoice.id}/xrechnung.xml`, headers: { cookie: adminCookie } });
  expect(xml.body).toContain(INSIDE_IBAN);
  insideIds = [einvoice.id];
  const mandate = (await admin.post(`/members/${outside.id}/mandates`, { signedOn: '2024-01-01', accountHolder: 'Olga Zzyzxfussball', iban: OUTSIDE.iban })).body;
  const invoice = (await admin.post('/invoices', { memberId: outside.id, lines: [{ text: 'Beitrag', unitCents: 6000 }] })).body;
  await admin.post(`/invoices/${invoice.id}/issue`, {});
  outsideMemberId = outside.id;
  outsidePersonId = outside.personId;
  ids = [outside.id, outside.personId, mandate?.id, invoice.id, football, ...insideIds, inside.id].filter(Boolean);
});

/** Every route of a method from the OpenAPI document, with path parameters filled in (lists also filtered by the outside member). */
function urls(method = 'get', idList = ids): string[] {
  const doc = ctx.app.swagger() as { paths: Record<string, Record<string, unknown>> };
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    if (!ops[method] || !path.startsWith('/api/v1/')) continue;
    const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    if (!params.length) {
      out.add(path);
      if (method === 'get') out.add(`${path}?memberId=${outsideMemberId}&personId=${outsidePersonId}`);
      continue;
    }
    for (const id of idList) {
      out.add(path.replace(/\{(\w+)\}/g, (_, p: string) => (/date/i.test(p) ? '2026-01-15' : /year/i.test(p) ? '2026' : /slug|token|code/i.test(p) ? 'x' : id)));
    }
  }
  return [...out];
}

async function scan(cookie: string, forbidden: string[]) {
  const leaks: string[] = [];
  for (const url of urls()) {
    const res = await ctx.app.inject({ url, headers: { cookie } });
    expect(res.statusCode, url).not.toBe(429);
    for (const needle of forbidden) if (res.body.includes(needle)) leaks.push(`${url} → ${needle}`);
  }
  return leaks;
}

describe('permission attacks', () => {
  it('a division lead sees nothing of another division on any GET route, and no IBAN at all', async () => {
    const lead = await userWithRole(ctx.app, adminCookie, 'Abteilungsleitung', [tennis]);
    expect(await scan(lead, [OUTSIDE.lastName, OUTSIDE.email, OUTSIDE.iban, INSIDE_IBAN])).toEqual([]);
    // The PDF of an in-scope invoice stays readable (it shows only the club's IBAN); the XML with the payer's IBAN does not.
    expect((await ctx.app.inject({ url: `/api/v1/invoices/${insideIds[0]}/pdf`, headers: { cookie: lead } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/api/v1/invoices/${insideIds[0]}/xrechnung.xml`, headers: { cookie: lead } })).statusCode).toBe(403);
  });

  it('a trainer and the tax adviser never see an IBAN', async () => {
    const trainer = await userWithRole(ctx.app, adminCookie, 'Trainer:in', null);
    expect(await scan(trainer, [OUTSIDE.iban, INSIDE_IBAN])).toEqual([]);
    const adviser = await userWithRole(ctx.app, adminCookie, 'Steuerberatung', null);
    expect(await scan(adviser, [OUTSIDE.iban, INSIDE_IBAN, OUTSIDE.email])).toEqual([]);
  });

  it('a division lead cannot change or delete anything of another division', async () => {
    const lead = await userWithRole(ctx.app, adminCookie, 'Abteilungsleitung', [tennis], 'lead2@example.org');
    const outsideIds = ids.slice(0, ids.length - insideIds.length - 1); // the rest belongs to the lead's own division
    const accepted: string[] = [];
    for (const method of ['patch', 'put', 'delete', 'post'] as const) {
      for (const url of urls(method, outsideIds).filter((u) => /[0-9a-f]{8}-/.test(u))) {
        const res = await ctx.app.inject({ method: method.toUpperCase() as 'POST', url, headers: { cookie: lead, 'idempotency-key': crypto.randomUUID() }, payload: {} });
        if (res.statusCode < 300) accepted.push(`${method.toUpperCase()} ${url} → ${res.statusCode}`);
      }
    }
    expect(accepted).toEqual([]);
    // Bulk routes that take ids in the body.
    const letters = await ctx.app.inject({ method: 'POST', url: '/api/v1/invoices/letters.pdf', headers: { cookie: lead, 'content-type': 'application/json' }, payload: { invoiceIds: outsideIds } });
    expect(letters.statusCode).toBe(404);
  });

  it('search does not match IBAN fragments', async () => {
    const admin = client(ctx.app, { cookie: adminCookie });
    const res = await admin.get('/members?q=0532013000');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('the scanner itself works: an admin does see the data', async () => {
    const leaks = await scan(adminCookie, [OUTSIDE.lastName, OUTSIDE.iban]);
    console.log(`scanned ${urls().length} URLs; admin sees ${leaks.length} hits`);
    expect(leaks.some((l) => l.includes(OUTSIDE.lastName))).toBe(true);
  });

  it('an admin of another club on the same installation sees nothing of this club on any GET route (managed hosting)', async () => {
    const { createClub } = await import('../src/server/routes/auth.ts');
    const { hashPassword } = await import('../src/server/auth/password.ts');
    await ctx.db.transaction().execute((tx) => hashPassword('ein-sehr-langes-passwort').then((passwordHash) => createClub(tx, { name: 'Anderer Verein', isDemo: false, hostname: null, admin: { email: 'fremd@example.org', name: 'Fremd Admin', passwordHash } })));
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'fremd@example.org', password: 'ein-sehr-langes-passwort' } });
    expect(login.statusCode, login.body).toBe(200);
    const other = String(login.headers['set-cookie']).split(';')[0]!;
    // With a fresh second factor, so finance routes run up to their club filter instead of stopping at step-up.
    await enrollTotp(ctx.app, other);
    // Even an admin (all rights, no field restrictions) must not see any record of the first club.
    const leaks = await scan(other, [OUTSIDE.lastName, OUTSIDE.email, OUTSIDE.iban, 'Innen', 'innen@example.org', INSIDE_IBAN, 'TSV Musterstadt']);
    expect(leaks).toEqual([]);
    // Nor change or delete anything of it, on any route that takes an id.
    const accepted: string[] = [];
    for (const method of ['patch', 'put', 'delete', 'post'] as const) {
      for (const url of urls(method, ids).filter((u) => /[0-9a-f]{8}-/.test(u))) {
        const res = await ctx.app.inject({ method: method.toUpperCase() as 'POST', url, headers: { cookie: other, 'idempotency-key': crypto.randomUUID() }, payload: {} });
        if (res.statusCode < 300) accepted.push(`${method.toUpperCase()} ${url} → ${res.statusCode}`);
      }
    }
    expect(accepted).toEqual([]);
    // Routes that take the first club's ids in the body.
    const body = (url: string, payload: object) => ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { cookie: other, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, payload });
    expect((await body('/invoices/letters.pdf', { invoiceIds: insideIds })).statusCode).toBe(404);
    expect((await body('/invoices/dunning-letters.pdf', { invoiceIds: insideIds })).statusCode).toBe(404);
    const mailed = await body('/invoices/send-mail', { invoiceIds: insideIds });
    expect(mailed.statusCode >= 400 || mailed.json().sent === 0).toBe(true);
    expect((await body('/offers', { memberId: outsideMemberId, lines: [{ text: 'x', unitCents: 1 }] })).statusCode).toBe(404);
    expect((await body('/tasks', { title: 'x', memberId: outsideMemberId })).statusCode).toBe(404);
    expect((await body('/collection-runs', { bankAccountId: outsideMemberId, collectionDate: '2026-12-01', invoiceIds: insideIds })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
