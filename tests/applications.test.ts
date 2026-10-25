import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { joinDateFor } from '../src/server/routes/applications.ts';
import { setMailer } from '../src/server/mail/transport.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

let admin: ReturnType<typeof client>;
let groupId: string;
let planId: string;
beforeEach(async () => {
  await reset(ctx.db);
  setMailer(null);
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
  await admin.patch('/organization', { creditorId: 'DE98ZZZ09999999999' });
  groupId = (await admin.post('/groups', { name: 'Schwimmen', shortCode: 'SW' })).body.id;
  planId = (await admin.post('/fee-plans', { name: 'Jugend', version: { amountCents: 6000, intervalMonths: 12, validFrom: '2020-01-01' } })).body.id;
  const f = await admin.post('/application-forms', { slug: 'mitmachen', title: 'Mitglied werden', groupIds: [groupId], feePlanIds: [planId], consentText: 'Ich erkenne die Satzung an und willige in die Datenverarbeitung ein.', allowedOrigins: ['https://tsv-beispiel.de'] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
});

const inbox = async (to: string) => (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()).messages as { ID: string; Subject: string; Attachments: number }[];
const person = { firstName: 'Lena', lastName: 'Lustig', birthDate: '2014-05-02', email: 'lena@example.org', street: 'Am Bad 3', postalCode: '12345', city: 'Musterstadt' };
const withPlan = () => ({ feePlanId: planId });

async function submit(data: Record<string, unknown>, opts: { wait?: boolean; honeypot?: boolean; token?: string } = {}) {
  const token = opts.token ?? (await ctx.app.inject({ method: 'GET', url: '/api/v1/public/forms/mitmachen' })).json().token;
  // Real people need a few seconds; the token carries the time the form was shown.
  if (opts.wait !== false && !opts.token) await new Promise((r) => setTimeout(r, 3100));
  return ctx.app.inject({ method: 'POST', url: '/api/v1/public/forms/mitmachen/submit', payload: { token, consent: true, website: opts.honeypot ? 'http://spam' : undefined, data } });
}

describe('applications', () => {
  it('joins on the first of the next month by default', () => {
    expect(joinDateFor('next_month_first', '2026-03-14', '2026-03-20')).toBe('2026-04-01');
    expect(joinDateFor('month_first', '2026-03-14', '2026-03-20')).toBe('2026-03-01');
    expect(joinDateFor('next_month_first', '2026-12-31', '2027-01-05')).toBe('2027-01-01');
  });

  it('turns a minor applicant with a parent account into member, group, fee and pending mandate in one step', async () => {
    const r = await submit({ ...person, groupIds: [groupId], feePlanId: planId, guardian: { name: 'Lars Lustig', email: 'eltern@example.org' }, mandate: { accountHolder: 'Lars Lustig', iban: 'DE02 1203 0000 0000 2020 51' } });
    expect(r.statusCode, r.body).toBe(201);
    const mails = await inbox('eltern@example.org');
    expect(mails[0]!.Attachments).toBe(1);
    const res = await admin.get('/applications');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = res.body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ minor: true, duplicates: [] });
    const acc = await admin.post(`/applications/${list[0].id}/accept`, {});
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.mandateStatus).toBe('pending_evidence');
    const m = (await admin.get(`/members/${acc.body.memberId}`)).body;
    expect(m).toMatchObject({ firstName: 'Lena', status: 'future' });
    const mandate = await ctx.db.selectFrom('sepa_mandate').selectAll().executeTakeFirstOrThrow();
    expect(mandate.account_holder).toBe('Lars Lustig');
    expect(await ctx.db.selectFrom('fee_assignment').select('id').execute()).toHaveLength(1);
    // The stored submission stays as it was sent, and its IBAN is encrypted, not in the payload.
    const stored = await ctx.db.selectFrom('application').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.payload)).not.toContain('DE02');
    expect(stored.iban_last4).toBe('2051');
    await expect(ctx.db.updateTable('application').set({ payload: JSON.stringify({ firstName: 'X' }) }).execute()).rejects.toThrow(/immutable/);
    expect((await inbox('eltern@example.org')).some((x) => x.Subject.startsWith('Willkommen'))).toBe(true);
  });

  it('keeps bots out of the inbox and asks before accepting a likely duplicate', async () => {
    expect((await submit({ ...person, ...withPlan() }, { wait: false })).statusCode).toBe(201);
    expect((await submit({ ...person, ...withPlan() }, { honeypot: true })).statusCode).toBe(201);
    // A token works once; replaying it files spam and sends nothing.
    const token = (await ctx.app.inject({ method: 'GET', url: '/api/v1/public/forms/mitmachen' })).json().token;
    await new Promise((r) => setTimeout(r, 3100));
    const grown = { ...person, ...withPlan(), birthDate: '1990-01-01', email: 'once@example.org' };
    expect((await submit(grown, { token })).statusCode).toBe(201);
    expect((await submit({ ...grown, email: 'victim@example.org' }, { token })).statusCode).toBe(201);
    expect(await inbox('victim@example.org')).toHaveLength(0);
    expect((await admin.get('/applications')).body).toHaveLength(1);
    const spam = (await admin.get('/applications?status=spam')).body;
    expect(spam).toHaveLength(3);
    // The board can bring a real person back from spam.
    expect((await admin.post('/applications/decide', { ids: [spam[0].id], action: 'restore' })).body.decided).toBe(1);
    await admin.post('/applications/decide', { ids: (await admin.get('/applications')).body.map((x: { id: string }) => x.id), action: 'spam' });

    await admin.post('/members', { firstName: 'Lena', lastName: 'Lustig', birthDate: '2014-05-02', joinDate: '2020-01-01' });
    const r = await submit({ ...person, ...withPlan(), birthDate: '1990-01-01', guardian: null });
    expect(r.statusCode, r.body).toBe(201);
    const [a] = (await admin.get('/applications')).body;
    void a;
    const adult = { ...person, ...withPlan(), birthDate: '2014-05-02', guardian: { name: 'Lars Lustig', email: 'eltern@example.org' } };
    await submit(adult);
    const dup = (await admin.get('/applications')).body.find((x: { data: { birthDate: string } }) => x.data.birthDate === '2014-05-02');
    expect(dup.duplicates[0].reason).toBe('gleicher Name und Geburtstag');
    expect((await admin.post(`/applications/${dup.id}/accept`, {})).status).toBe(409);
    expect((await admin.post(`/applications/${dup.id}/accept`, { ignoreDuplicates: true })).status).toBe(200);
    const rest = (await admin.get('/applications')).body;
    expect((await admin.post('/applications/decide', { ids: rest.map((x: { id: string }) => x.id), action: 'reject', reason: 'Die Gruppe ist voll.' })).body.decided).toBe(1);
    // After the retention period everything identifying goes, and the list still loads (Codex review of #10).
    await ctx.db.updateTable('application').set({ decided_at: new Date(Date.now() - 200 * 86_400_000) }).where('status', '=', 'rejected').execute();
    const { pruneApplications } = await import('../src/server/routes/applications.ts');
    await pruneApplications(ctx.db);
    const scrubbed = await ctx.db.selectFrom('application').select(['payload', 'iban_last4', 'reason']).where('status', '=', 'rejected').execute();
    expect(scrubbed.every((x) => JSON.stringify(x.payload) === '{}' && x.iban_last4 === null && x.reason === null)).toBe(true);
    const list = await admin.get('/applications?status=rejected');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it('requires a guardian for minors', async () => {
    const r = await submit({ ...person, ...withPlan(), guardian: null });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0].field).toBe('data.guardian');
  });
});
