import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt } from '../src/server/crypto.ts';
import { setMailer } from '../src/server/mail/transport.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

let admin: ReturnType<typeof client>;
let adminCookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  setMailer(null);
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
});

const inbox = async (to: string) => (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()).messages as { ID: string; Subject: string }[];
const text = async (id: string) => String((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()).Text);
const post = (url: string, payload: unknown, cookie?: string) => ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: cookie ? { cookie } : {}, payload: payload as object });
const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });

/** Signs in through the mailed code and returns the portal cookie. */
async function signIn(email: string) {
  await post('/portal/auth/request-code', { email });
  const mail = (await inbox(email))[0]!;
  const code = (await text(mail.ID)).match(/\b(\d{6})\b/)![1]!;
  const r = await post('/portal/auth/verify', { email, code });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0]!;
}

describe('member portal', () => {
  it('signs in by e-mailed code, shows family memberships and only own invoices', async () => {
    await admin.patch('/organization', { street: 'Weg 1', postalCode: '12345', city: 'Musterstadt', iban: 'DE89370400440532013000' });
    const mum = (await admin.post('/members', { firstName: 'Mara', lastName: 'Mutter', email: 'familie@example.org', joinDate: '2024-01-01' })).body.id;
    const kid = (await admin.post('/members', { firstName: 'Kim', lastName: 'Mutter', email: 'familie@example.org', joinDate: '2024-01-01' })).body.id;
    const other = (await admin.post('/members', { firstName: 'Olaf', lastName: 'Anders', email: 'olaf@example.org', joinDate: '2024-01-01' })).body.id;
    const invoices: string[] = [];
    for (const m of [kid, other]) {
      const d = await admin.post('/invoices', { memberId: m, lines: [{ text: 'Beitrag', unitCents: 3000 }] });
      await admin.post(`/invoices/${d.body.id}/issue`, {});
      invoices.push(d.body.id);
    }
    // Unknown addresses get the same answer and no mail.
    expect((await post('/portal/auth/request-code', { email: 'nobody@example.org' })).statusCode).toBe(200);
    expect(await inbox('nobody@example.org')).toHaveLength(0);

    const cookie = await signIn('familie@example.org');
    const me = (await get('/portal/me', cookie)).json();
    expect(me.members.map((m: { memberId: string }) => m.memberId).sort()).toEqual([mum, kid].sort());
    const list = (await get('/portal/invoices', cookie)).json();
    expect(list.map((i: { id: string }) => i.id)).toEqual([invoices[0]]);
    expect((await get(`/portal/invoices/${invoices[1]}/pdf`, cookie)).statusCode).toBe(404);
    const qr = await get(`/portal/invoices/${invoices[0]}/qr.svg`, cookie);
    expect(qr.statusCode).toBe(200);
    expect(qr.body).toContain('<svg');
    // The admin API stays closed to portal sessions.
    expect((await get('/members', cookie)).statusCode).toBe(401);
  });

  it('limits code attempts and expires codes', async () => {
    await admin.post('/members', { lastName: 'Code', email: 'code@example.org', joinDate: '2024-01-01' });
    await post('/portal/auth/request-code', { email: 'code@example.org' });
    for (let i = 0; i < 5; i++) expect((await post('/portal/auth/verify', { email: 'code@example.org', code: '000000' })).statusCode).toBe(400);
    const code = (await text((await inbox('code@example.org'))[0]!.ID)).match(/\b(\d{6})\b/)![1]!;
    expect((await post('/portal/auth/verify', { email: 'code@example.org', code })).statusCode).toBe(400); // used up by wrong attempts
    await post('/portal/auth/request-code', { email: 'code@example.org' });
    await ctx.db.updateTable('login_code').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    const fresh = (await text((await inbox('code@example.org'))[0]!.ID)).match(/\b(\d{6})\b/)![1]!;
    expect((await post('/portal/auth/verify', { email: 'code@example.org', code: fresh })).statusCode).toBe(400);
    // An admin can hand out a code when mail does not arrive.
    const m = (await admin.get('/members?q=code')).body.items[0].id;
    const issued = (await admin.post(`/members/${m}/portal-code`, {})).body;
    expect((await post('/portal/auth/verify', { email: 'code@example.org', code: issued.code })).statusCode).toBe(200);
  });

  it('applies phone at once, queues the rest for approval, supersedes, and amends the mandate on an IBAN change', async () => {
    const m = (await admin.post('/members', { firstName: 'Paula', lastName: 'Portal', email: 'paula@example.org', joinDate: '2024-01-01' })).body.id;
    await admin.post(`/members/${m}/mandates`, { signedOn: '2024-01-01', accountHolder: 'Paula Portal', iban: 'DE02120300000000202051' });
    const cookie = await signIn('paula@example.org');
    const change = (field: string, value: string) => post('/portal/change-requests', { memberId: m, field, value }, cookie);
    expect((await change('phone', '0171 1234567')).json().status).toBe('applied');
    expect((await admin.get(`/members/${m}`)).body.phone).toBe('0171 1234567');
    await change('street', 'Alte Straße 1');
    await change('street', 'Neue Straße 2');
    expect((await change('iban', 'DE89 3704 0044 0532 0130 00')).json().status).toBe('pending');
    expect((await change('iban', 'DE00 1234')).statusCode).toBe(400);
    const pending = (await admin.get('/change-requests')).body as { id: string; field: string; newValue: string }[];
    expect(pending.map((p) => p.field).sort()).toEqual(['iban', 'street']);
    expect(pending.find((p) => p.field === 'street')!.newValue).toBe('Neue Straße 2');
    expect(pending.find((p) => p.field === 'iban')!.newValue).toBe('•••• 3000');

    await admin.post(`/change-requests/${pending.find((p) => p.field === 'street')!.id}/deny`, { reason: 'Bitte mit Hausnummer und Ort.' });
    expect((await inbox('paula@example.org')).some((x) => x.Subject.includes('Deine Änderung'))).toBe(true);
    const acc = await admin.post(`/change-requests/${pending.find((p) => p.field === 'iban')!.id}/accept`, {});
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const mandate = await ctx.db.selectFrom('sepa_mandate').selectAll().executeTakeFirstOrThrow();
    expect(decrypt(mandate.iban_encrypted)).toBe('DE89370400440532013000');
    expect(mandate.amendment_pending).toBe(true);
    expect(decrypt(mandate.amended_from_iban_encrypted!)).toBe('DE02120300000000202051');
  });

  it('turns a portal resignation into dates once the board confirms it, and shares documents', async () => {
    const m = (await admin.post('/members', { firstName: 'Rita', lastName: 'Raus', email: 'rita@example.org', joinDate: '2020-01-01' })).body.id;
    const cookie = await signIn('rita@example.org');
    const r = await post('/portal/resignation', { memberId: m }, cookie);
    expect(r.statusCode, r.body).toBe(200);
    const exit = r.json().exitDate;
    expect((await inbox('rita@example.org')).some((x) => x.Subject.includes('Kündigung'))).toBe(true);
    const req = (await admin.get('/change-requests')).body.find((c: { field: string }) => c.field === 'resignation');
    await admin.post(`/change-requests/${req.id}/accept`, {});
    expect((await admin.get(`/members/${m}`)).body).toMatchObject({ status: 'resigned', exitDate: exit });

    const shared = (await admin.post('/folders', { name: 'Satzung', shareWithMembers: true })).body;
    await admin.post('/folders', { name: 'Intern' });
    const up = await ctx.app.inject({ method: 'POST', url: `/api/v1/files?name=Satzung.pdf&folderId=${shared.id}`, headers: { cookie: adminCookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf' }, payload: '%PDF satzung' });
    expect(up.statusCode, up.body).toBe(201);
    const docs = (await get('/portal/documents', cookie)).json();
    expect(docs.map((d: { name: string }) => d.name)).toEqual(['Satzung.pdf']);
    expect((await get(`/portal/documents/${docs[0].id}`, cookie)).body).toBe('%PDF satzung');
  });
});
