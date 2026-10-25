import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt } from '../src/server/crypto.ts';
import { setMailer } from '../src/server/mail/transport.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

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
/** Waits up to two seconds for the n-th mail to an address (mails go out after the response). */
async function mailTo(to: string, n = 1) {
  for (let i = 0; i < 40; i++) {
    const m = await inbox(to);
    if (m.length >= n) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no mail to ${to}`);
}
const text = async (id: string) => String((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()).Text);
const post = (url: string, payload: unknown, cookie?: string) => ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: cookie ? { cookie } : {}, payload: payload as object });
const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });

/** Signs in through the mailed code and returns the portal cookie. */
async function signIn(email: string) {
  await post('/portal/auth/request-code', { email });
  // The code goes out after the answer (same timing for members and strangers), so wait for it.
  let mail: { ID: string } | undefined;
  for (let i = 0; i < 40 && !mail; i++) {
    mail = (await inbox(email))[0];
    if (!mail) await new Promise((r) => setTimeout(r, 50));
  }
  const code = (await text(mail!.ID)).match(/\b(\d{6})\b/)![1]!;
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

  it('shows the custom fields the club marks as visible to members, and only those', async () => {
    const size = (await admin.post('/custom-fields', { key: 'trikot', label: 'Trikotgröße', type: 'select', options: ['S', 'M'], visibleToMember: true })).body;
    const note = (await admin.post('/custom-fields', { key: 'intern', label: 'Interne Notiz', type: 'text' })).body;
    const health = (await admin.post('/custom-fields', { key: 'gesundheit', label: 'Gesundheit', type: 'text', sensitive: true, visibleToMember: true })).body;
    await admin.post('/members', { firstName: 'Fritz', lastName: 'Feld', email: 'feld@example.org', joinDate: '2024-01-01', custom: { [size.id]: 'M', [note.id]: 'schwierig', [health.id]: 'Asthma' } });
    await admin.post('/members', { firstName: 'Frieda', lastName: 'Feld', email: 'feld@example.org', joinDate: '2024-01-01', custom: { [size.id]: 'S' } });
    const cookie = await signIn('feld@example.org');
    const me = JSON.parse((await get('/portal/me', cookie)).body);
    // Each card carries its own values; internal and sensitive fields never appear.
    const byName = Object.fromEntries(me.members.map((m: { firstName: string; custom: unknown }) => [m.firstName, m.custom]));
    expect(byName.Fritz).toEqual([{ key: 'trikot', label: 'Trikotgröße', value: 'M' }]);
    expect(byName.Frieda).toEqual([{ key: 'trikot', label: 'Trikotgröße', value: 'S' }]);
  });

  it('limits code attempts and expires codes', async () => {
    await admin.post('/members', { lastName: 'Code', email: 'code@example.org', joinDate: '2024-01-01' });
    await post('/portal/auth/request-code', { email: 'code@example.org' });
    // The code is issued after the answer (same timing for unknown addresses): wait for its mail before guessing.
    const code = (await text((await mailTo('code@example.org'))[0]!.ID)).match(/\b(\d{6})\b/)![1]!;
    for (let i = 0; i < 5; i++) expect((await post('/portal/auth/verify', { email: 'code@example.org', code: '000000' })).statusCode).toBe(400);
    expect((await post('/portal/auth/verify', { email: 'code@example.org', code })).statusCode).toBe(400); // used up by wrong attempts
    // An admin can hand out a code when mail does not arrive; a newer mailed code does not hide it.
    const m = (await admin.get('/members?q=code')).body.items[0].id;
    const issued = (await admin.post(`/members/${m}/portal-code`, {})).body;
    await post('/portal/auth/request-code', { email: 'code@example.org' });
    await mailTo('code@example.org', 2);
    expect((await post('/portal/auth/verify', { email: 'code@example.org', code: issued.code })).statusCode).toBe(200);
    // Signing in consumes every live code for the address.
    expect(await ctx.db.selectFrom('login_code').select('id').where('consumed_at', 'is', null).execute()).toHaveLength(0);
    // Ten wrong codes a day per address, across all codes.
    await admin.post(`/members/${m}/portal-code`, {});
    await admin.post(`/members/${m}/portal-code`, {});
    for (let i = 0; i < 5; i++) await post('/portal/auth/verify', { email: 'code@example.org', code: '111111' });
    const last = await admin.post(`/members/${m}/portal-code`, {});
    expect((await post('/portal/auth/verify', { email: 'code@example.org', code: last.body.code })).statusCode).toBe(429);
  });

  it('applies phone at once, queues the rest for approval, supersedes, and amends the mandate on an IBAN change', async () => {
    const m = (await admin.post('/members', { firstName: 'Paula', lastName: 'Portal', email: 'paula@example.org', joinDate: '2024-01-01' })).body.id;
    await admin.post(`/members/${m}/mandates`, { signedOn: '2024-01-01', accountHolder: 'Paula Portal', iban: 'DE02120300000000202051' });
    const cookie = await signIn('paula@example.org');
    const change = (body: Record<string, unknown>) => post('/portal/change-requests', { memberId: m, ...body }, cookie);
    expect((await change({ field: 'phone', value: '0171 1234567' })).json().status).toBe('applied');
    expect((await admin.get(`/members/${m}`)).body.phone).toBe('0171 1234567');
    await change({ field: 'address', street: 'Alte Straße 1', postalCode: '12345', city: 'Altstadt' });
    await change({ field: 'address', street: 'Neue Straße 2', postalCode: '12345', city: 'Neustadt' });
    expect((await change({ field: 'address', street: 'X', postalCode: '1234', city: 'Y' })).statusCode).toBe(400);
    expect((await change({ field: 'iban', iban: 'DE89 3704 0044 0532 0130 00', accountHolder: 'Paula Portal' })).json().status).toBe('pending');
    expect((await change({ field: 'iban', iban: 'DE00 1234', accountHolder: 'Paula Portal' })).statusCode).toBe(400);
    const pending = (await admin.get('/change-requests')).body as { id: string; field: string; newValue: string }[];
    expect(pending.map((p) => p.field).sort()).toEqual(['address', 'iban']);
    expect(pending.find((p) => p.field === 'address')!.newValue).toBe('Neue Straße 2, 12345 Neustadt');
    expect(pending.find((p) => p.field === 'iban')!.newValue).toBe('•••• 3000, Inhaber:in Paula Portal');

    await admin.post(`/change-requests/${pending.find((p) => p.field === 'address')!.id}/deny`, { reason: 'Bitte mit Hausnummer und Ort.' });
    expect((await inbox('paula@example.org')).some((x) => x.Subject.includes('Deine Änderung'))).toBe(true);
    // The bank knows this mandate once it has been collected; only then does a change need an amendment.
    await ctx.db.updateTable('sepa_mandate').set({ first_collected: true }).execute();
    const acc = await admin.post(`/change-requests/${pending.find((p) => p.field === 'iban')!.id}/accept`, {});
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.needsNewMandate).toBe(false);
    const mandate = await ctx.db.selectFrom('sepa_mandate').selectAll().executeTakeFirstOrThrow();
    expect(decrypt(mandate.iban_encrypted)).toBe('DE89370400440532013000');
    expect(mandate.amendment_pending).toBe(true);
    expect(decrypt(mandate.amended_from_iban_encrypted!)).toBe('DE02120300000000202051');

    // Someone else's account needs a new mandate; nothing changes.
    await change({ field: 'iban', iban: 'DE02120300000000202051', accountHolder: 'Peter Partner' });
    const other = (await admin.get('/change-requests')).body.find((p: { field: string }) => p.field === 'iban');
    expect((await admin.post(`/change-requests/${other.id}/accept`, {})).body.needsNewMandate).toBe(true);
    expect(decrypt((await ctx.db.selectFrom('sepa_mandate').select('iban_encrypted').executeTakeFirstOrThrow()).iban_encrypted)).toBe('DE89370400440532013000');
  });

  it('turns a portal resignation into dates once the board confirms it, and shares documents', async () => {
    const m = (await admin.post('/members', { firstName: 'Rita', lastName: 'Raus', email: 'rita@example.org', joinDate: '2020-01-01' })).body.id;
    const cookie = await signIn('rita@example.org');
    // Portal settings: the club switches resignation and the contact off; a group allows resignation again.
    expect((await admin.patch('/organization', { portalFeatures: { resignation: false, contact: false, bogus: true } })).status).toBe(400);
    await admin.patch('/organization', { portalFeatures: { resignation: false, contact: false } });
    const off = (await get('/portal/me', cookie)).json();
    expect(off.club.email).toBeNull();
    expect(off.members[0].features).toMatchObject({ resignation: false, invoices: true });
    expect((await post('/portal/resignation', { memberId: m }, cookie)).statusCode).toBe(403);
    const seniors = (await admin.post('/groups', { name: 'Senioren', shortCode: 'SEN' })).body.id;
    expect((await admin.patch(`/groups/${seniors}`, { portalOverrides: { resignation: 'allow', bank: 'deny' } })).body.portalOverrides).toEqual({ resignation: 'allow', bank: 'deny' });
    await admin.post('/group-memberships', { memberId: m, groupId: seniors, validFrom: '2020-01-01' });
    expect((await get('/portal/me', cookie)).json().members[0].features).toMatchObject({ resignation: true, bank: false });
    expect((await post('/portal/change-requests', { memberId: m, field: 'iban', iban: 'DE02120300000000202051', accountHolder: 'Rita Raus' }, cookie)).statusCode).toBe(403);
    const r = await post('/portal/resignation', { memberId: m }, cookie);
    expect(r.statusCode, r.body).toBe(200);
    const exit = r.json().exitDate;
    expect((await inbox('rita@example.org')).some((x) => x.Subject.includes('Kündigung'))).toBe(true);
    const req = (await admin.get('/change-requests')).body.find((c: { field: string }) => c.field === 'resignation');
    await admin.post(`/change-requests/${req.id}/accept`, {});
    expect((await admin.get(`/members/${m}`)).body).toMatchObject({ status: 'resigned', exitDate: exit });

    // The member's own donation receipts, as PDF; a cancelled one stays listed but is not handed out.
    const year = new Date().getFullYear();
    await admin.put('/donations/settings', { kind: 'freistellung', office: 'Musterstadt', taxNumber: '12/345/67890', date: `${year - 1}-05-01`, period: '2021–2023', purposes: 'des Sports (§ 52 Abs. 2 Satz 1 Nr. 21 AO)', signer: 'Erika Mustermann, Kassenwartin' });
    const person = (await admin.get(`/members/${m}`)).body.personId;
    await admin.patch('/organization', { street: 'Weg 1', postalCode: '12345', city: 'Musterstadt' });
    await admin.patch(`/members/${m}`, { street: 'Lindenweg 3', postalCode: '12345', city: 'Musterstadt' });
    const d = await admin.post('/donations', { personId: person, date: `${year}-01-10`, amountCents: 5000 });
    const rc = await admin.post('/donation-receipts', { personId: person, donationIds: [d.body.id] });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    const mine = (await get('/portal/donation-receipts', cookie)).json();
    expect(mine).toEqual([expect.objectContaining({ number: rc.body.number, totalCents: 5000, status: 'issued' })]);
    expect((await get(`/portal/donation-receipts/${rc.body.id}/pdf`, cookie)).body.slice(0, 5)).toBe('%PDF-');
    await admin.post(`/donation-receipts/${rc.body.id}/cancel`, { reason: 'Betrag falsch erfasst' });
    expect((await get(`/portal/donation-receipts/${rc.body.id}/pdf`, cookie)).statusCode).toBe(410);

    const shared = (await admin.post('/folders', { name: 'Satzung', shareWithMembers: true })).body;
    await admin.post('/folders', { name: 'Intern' });
    const up = await ctx.app.inject({ method: 'POST', url: `/api/v1/files?name=Satzung.pdf&folderId=${shared.id}`, headers: { cookie: adminCookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf' }, payload: '%PDF satzung' });
    expect(up.statusCode, up.body).toBe(201);
    const docs = (await get('/portal/documents', cookie)).json();
    expect(docs.map((d: { name: string }) => d.name)).toEqual(['Satzung.pdf']);
    expect((await get(`/portal/documents/${docs[0].id}`, cookie)).body).toBe('%PDF satzung');
  });

  it('members submit expense claims with a receipt; the treasurer approves into an open receipt or rejects', async () => {
    const m = (await admin.post('/members', { firstName: 'Ali', lastName: 'Auslage', email: 'ali@example.org', joinDate: '2024-01-01' })).body;
    const cookie = await signIn('ali@example.org');
    const up = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/expenses/files?name=bon.pdf', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf' }, payload: Buffer.from('%PDF-1.4 Kassenbon') });
    expect(up.statusCode, up.body).toBe(201);
    const fileId = up.json().id;
    const html = await ctx.app.inject({ method: 'POST', url: '/api/v1/portal/expenses/files?name=x.html', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/html' }, payload: Buffer.from('<script>') });
    expect(html.statusCode).toBe(415);
    const claim = { memberId: m.id, purpose: 'Bälle für das Training', spentOn: '2026-03-02', amountCents: 4590, accountHolder: 'Ali Auslage', iban: 'DE02 1203 0000 0000 2020 51', fileId };
    const sub = await post('/portal/expenses', claim, cookie);
    expect(sub.statusCode, sub.body).toBe(201);
    // The same upload cannot be claimed twice.
    expect((await post('/portal/expenses', claim, cookie)).statusCode).toBe(409);
    expect((await get('/portal/expenses', cookie)).json()[0]).toMatchObject({ status: 'submitted', amountCents: 4590 });

    const list = (await admin.get('/expense-claims')).body;
    expect(list[0]).toMatchObject({ name: 'Auslage, Ali', iban: 'DE02120300000000202051', status: 'submitted' });
    expect((await ctx.app.inject({ url: `/api/v1/expense-claims/${list[0].id}/file`, headers: { cookie: adminCookie } })).body).toContain('Kassenbon');
    const accounts = (await admin.get('/ledger/accounts')).body as { id: string; kind: string }[];
    const expenseAccount = accounts.find((a) => a.kind === 'expense')!.id;
    const ok = await admin.post(`/expense-claims/${list[0].id}/approve`, { accountId: expenseAccount, sphere: 'ideell' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
    const receipts = (await admin.get('/receipts')).body as { id: string; supplier: string; status: string; totalCents: number }[];
    expect(receipts.find((r) => r.id === ok.body.receiptId)).toMatchObject({ supplier: 'Auslage Auslage, Ali', status: 'open', totalCents: 4590 });
    expect((await admin.post(`/expense-claims/${list[0].id}/reject`, { reason: 'zu spät' })).status).toBe(409);
    // The member hears about the decision.
    const mails = await mailTo('ali@example.org', 2);
    expect(mails.map((x) => x.Subject)).toContain('Deine Auslage bei TSV Musterstadt 1890 e.V.');
    expect((await get('/portal/expenses', cookie)).json()[0].status).toBe('approved');

    // The membership certificate: own one in the portal, nobody else's; any member's for admins.
    const own = await get(`/portal/members/${m.id}/certificate.pdf`, cookie);
    expect(own.statusCode).toBe(200);
    expect(own.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const other = (await admin.post('/members', { lastName: 'Fremd', joinDate: '2020-01-01' })).body;
    expect((await get(`/portal/members/${other.id}/certificate.pdf`, cookie)).statusCode).toBe(404);
    expect((await get(`/members/${m.id}/certificate.pdf`, adminCookie)).statusCode).toBe(200);

    // Polls: one answer per membership, changeable while open, results only after the end, group polls only for the group.
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const poll = (await admin.post('/polls', { question: 'Sommerfest am Samstag oder Sonntag?', options: ['Samstag', 'Sonntag'], closesOn: day(7) })).body;
    expect(poll).toMatchObject({ open: true, answered: 0 });
    const board = (await admin.post('/groups', { name: 'Vorstand', shortCode: 'VS', kind: 'board' })).body.id;
    await admin.post('/polls', { question: 'Nur Vorstand', options: ['Ja', 'Nein'], closesOn: day(7), groupId: board });
    const listed = (await get('/portal/polls', cookie)).json();
    expect(listed.map((x: { question: string }) => x.question)).toEqual(['Sommerfest am Samstag oder Sonntag?']);
    expect(listed[0].results).toBeNull();
    expect((await post(`/portal/polls/${poll.id}/vote`, { memberId: m.id, choices: [0, 1] }, cookie)).statusCode).toBe(400);
    expect((await post(`/portal/polls/${poll.id}/vote`, { memberId: m.id, choices: [0] }, cookie)).statusCode).toBe(204);
    expect((await post(`/portal/polls/${poll.id}/vote`, { memberId: m.id, choices: [1] }, cookie)).statusCode).toBe(204);
    const closed = (await admin.post(`/polls/${poll.id}/close`, {})).body;
    expect(closed).toMatchObject({ open: false, answered: 1, counts: [0, 1] });
    expect((await get('/portal/polls', cookie)).json()[0].results.counts).toEqual([0, 1]);
    expect((await post(`/portal/polls/${poll.id}/vote`, { memberId: m.id, choices: [0] }, cookie)).statusCode).toBe(409);
  });

  it('lets the household payer manage its members, but adults with their own address resign themselves', async () => {
    const mum = (await admin.post('/members', { firstName: 'Maria', lastName: 'Haus', email: 'maria@example.org', joinDate: '2020-01-01' })).body;
    const kid = (await admin.post('/members', { firstName: 'Kim', lastName: 'Haus', birthDate: '2015-01-01', joinDate: '2020-01-01' })).body;
    const partner = (await admin.post('/members', { firstName: 'Paul', lastName: 'Haus', email: 'paul@example.org', joinDate: '2020-01-01' })).body;
    const h = await admin.post('/households', { name: 'Familie Haus', payerPersonId: mum.personId, memberIds: [mum.id, kid.id, partner.id] });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    const cookie = await signIn('maria@example.org');
    const me = (await get('/portal/me', cookie)).json();
    expect(me.members.map((m: { name: string; managed: boolean }) => [m.name, m.managed]).sort()).toEqual([['Kim Haus', true], ['Maria Haus', false], ['Paul Haus', true]]);
    expect((await post('/portal/resignation', { memberId: kid.id }, cookie)).statusCode).toBe(200);
    expect((await post('/portal/resignation', { memberId: partner.id }, cookie)).statusCode).toBe(403);
    // Paul's own portal shows only Paul.
    const paul = await signIn('paul@example.org');
    expect((await get('/portal/me', paul)).json().members.map((m: { name: string }) => m.name)).toEqual(['Paul Haus']);
  });


  it('Codex review #9: only admins issue portal codes', async () => {
    const m = (await admin.post('/members', { firstName: 'Paul', lastName: 'Portal', email: 'paul@example.org', joinDate: '2020-01-01' })).body.id;
    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Abteilungsleitung') });
    expect((await lead.post(`/members/${m}/portal-code`, {})).status).toBe(403);
  });
});
