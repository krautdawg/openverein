import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processQueue } from '../src/server/mail/worker.ts';
import { setMailer } from '../src/server/mail/transport.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

let admin: ReturnType<typeof client>;
beforeEach(async () => {
  await reset(ctx.db);
  setMailer(null);
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
});

const member = async (lastName: string, email: string | null, extra: Record<string, unknown> = {}) => (await admin.post('/members', { firstName: 'Eva', lastName, email, joinDate: '2024-01-01', ...extra })).body.id as string;
const inbox = async (to: string) => (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()).messages as { ID: string; Subject: string; Attachments: number }[];

describe('messages', () => {
  it('excludes members without address or not current, fills placeholders and logs deliveries', async () => {
    await member('Post', 'eva.post@example.org');
    await member('Ohne', null);
    const gone = await member('Weg', 'weg@example.org', { joinDate: '2010-01-01' });
    await admin.post(`/members/${gone}/resign`, { noticeDate: '2020-01-01', exitDate: '2020-12-31' });
    const r = (await admin.post('/messages/recipients', { filter: { mode: 'all' } })).body;
    expect(r.recipients.map((x: { email: string }) => x.email)).toEqual(['eva.post@example.org']);
    expect(r.excluded.map((x: { reason: string }) => x.reason).sort()).toEqual(['kein aktuelles Mitglied', 'keine E-Mail-Adresse']);

    const sent = await admin.post('/messages', { subject: 'Hallo {{vorname}}', body: 'Liebe {{vorname}} {{nachname}},\n\nbis Samstag!\n{{verein}}', filter: { mode: 'all' } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(await processQueue(ctx.db)).toBe(1);
    const mails = await inbox('eva.post@example.org');
    expect(mails[0]!.Subject).toBe('Hallo Eva');
    const detail = (await admin.get(`/messages/${sent.body.id}`)).body;
    expect(detail).toMatchObject({ status: 'sent', counts: { total: 1, sent: 1 } });
    const events = await ctx.db.selectFrom('audit_event').select('diff').where('action', '=', 'message.sent').executeTakeFirstOrThrow();
    expect(JSON.stringify(events.diff)).not.toContain('example.org');
  });

  it('newsletters carry an unsubscribe link that stops newsletters but not club notices', async () => {
    await member('Abo', 'abo@example.org');
    const nl = await admin.post('/messages', { subject: 'Rundschreiben', body: 'Neuigkeiten', category: 'newsletter', filter: { mode: 'all' } });
    await processQueue(ctx.db, { baseUrl: 'https://verein.example' });
    const msg = await (await fetch(`${MAILPIT}/api/v1/message/${(await inbox('abo@example.org'))[0]!.ID}`)).json();
    const token = String(msg.Text).match(/abmelden#([^\s]+)/)![1]!;
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/unsubscribe', payload: { token } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/unsubscribe', payload: { token: token.slice(0, -2) + 'xx' } })).statusCode).toBe(400);
    expect((await admin.post('/messages/recipients', { filter: { mode: 'all' }, category: 'newsletter' })).body.recipients).toHaveLength(0);
    expect((await admin.post('/messages/recipients', { filter: { mode: 'all' }, category: 'notice' })).body.recipients).toHaveLength(1);
    void nl;
  });

  it('marks hard bounces and suppresses the address; retries temporary failures', async () => {
    await member('Bounce', 'nobody@example.org');
    let calls = 0;
    setMailer({ sendMail: async () => { calls++; throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }); } } as never);
    const m = await admin.post('/messages', { subject: 'X', body: 'Y', filter: { mode: 'all' } });
    await processQueue(ctx.db);
    expect((await admin.get(`/messages/${m.body.id}`)).body.deliveries[0].status).toBe('bounced');
    expect((await admin.post('/messages/recipients', { filter: { mode: 'all' } })).body.excluded[0].reason).toContain('gesperrt');
    expect(calls).toBe(1);

    await member('Temp', 'temp@example.org');
    setMailer({ sendMail: async () => { throw Object.assign(new Error('421 try later'), { responseCode: 421 }); } } as never);
    const t = await admin.post('/messages', { subject: 'X', body: 'Y', filter: { mode: 'members', memberIds: [(await admin.get('/members?q=temp')).body.items[0].id] } });
    await processQueue(ctx.db);
    expect((await admin.get(`/messages/${t.body.id}`)).body.deliveries[0].status).toBe('queued');
  });

  it('sends invoices with their PDF and lists letter recipients for printing', async () => {
    await admin.patch('/organization', { street: 'Weg 1', postalCode: '12345', city: 'Musterstadt' });
    const a = await member('Mail', 'rechnung@example.org');
    const b = await member('Brief', 'brief@example.org', { preferredChannel: 'letter' });
    const ids: string[] = [];
    for (const m of [a, b]) {
      const d = await admin.post('/invoices', { memberId: m, lines: [{ text: 'Beitrag', unitCents: 4200 }] });
      await admin.post(`/invoices/${d.body.id}/issue`, {});
      ids.push(d.body.id);
    }
    const res = await admin.post('/invoices/send-mail', { invoiceIds: ids });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.toPrint).toHaveLength(1);
    expect(res.body.toPrint[0].reason).toBe('bevorzugt Brief');
    await processQueue(ctx.db);
    const mails = await inbox('rechnung@example.org');
    expect(mails[0]!.Subject).toMatch(/^Deine Rechnung R-\d{4}-00001$/);
    expect(mails[0]!.Attachments).toBe(1);
  });

  it('mails invitations to new users', async () => {
    const roles = (await admin.get('/roles')).body;
    const res = await admin.post('/users', { name: 'Kai Kasse', email: 'kai@example.org', grants: [{ roleId: roles[1].id }] });
    expect(res.body.mailed).toBe(true);
    expect((await inbox('kai@example.org'))[0]!.Subject).toContain('Dein Zugang');
  });

  it('uses edited system texts, sends dunning only for open invoices, and lets admins block and unblock addresses', async () => {
    await admin.patch('/organization', { street: 'Weg 1', postalCode: '12345', city: 'Musterstadt' });
    expect((await admin.put('/mail-templates/dunning', { name: 'x', subject: 'Erinnerung {{rechnungsnummer}}: {{offen}} offen', body: 'Hallo {{vorname}}' })).status).toBe(200);
    const a = await member('Offen', 'offen@example.org');
    const d = await admin.post('/invoices', { memberId: a, lines: [{ text: 'Beitrag', unitCents: 3000 }] });
    await admin.post(`/invoices/${d.body.id}/issue`, {});
    const paid = await admin.post('/invoices', { memberId: a, lines: [{ text: 'Kurs', unitCents: 1000 }] });
    await admin.post(`/invoices/${paid.body.id}/issue`, {});
    await admin.post(`/invoices/${paid.body.id}/payments`, { amountCents: 1000, method: 'cash', bookedOn: '2026-01-02' });
    const res = await admin.post('/invoices/send-mail', { invoiceIds: [d.body.id, paid.body.id], template: 'dunning' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.message.counts.total).toBe(1);
    await processQueue(ctx.db);
    expect((await inbox('offen@example.org'))[0]!.Subject).toMatch(/^Erinnerung R-\d{4}-00001: 30,00\s€ offen$/);

    const del = (await admin.get(`/messages/${res.body.message.id}`)).body.deliveries[0];
    expect((await admin.post(`/deliveries/${del.id}/bounce`, {})).status).toBe(200);
    expect((await admin.post('/messages/recipients', { filter: { mode: 'all' } })).body.recipients).toHaveLength(0);
    expect((await admin.post('/mail/unblock', { email: 'OFFEN@example.org' })).body.removed).toBe(true);
    expect((await admin.post('/messages/recipients', { filter: { mode: 'all' } })).body.recipients).toHaveLength(1);

    const list = (await admin.get('/mail-templates')).body as { id: string; custom: boolean }[];
    expect(list.find((t) => t.id === 'dunning')!.custom).toBe(true);
    expect((await admin.del('/mail-templates/dunning')).status).toBe(204);
  });
});
