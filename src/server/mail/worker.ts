import { timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { customPlaceholders, fill, textToHtml, type PlaceholderValues } from '../../shared/mail.ts';
import { blindIndex, decryptBytes } from '../crypto.ts';
import type { Db } from '../db.ts';
import { storedPdf } from '../invoices/service.ts';
import { mailer, senderOf } from './transport.ts';

export const unsubscribeToken = (deliveryId: string) => `${deliveryId}.${blindIndex(`unsubscribe:${deliveryId}`).slice(0, 32)}`;
export function deliveryFromToken(token: string) {
  const [id, mac] = token.split('.');
  if (!id || !mac || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const want = Buffer.from(unsubscribeToken(id));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}
export const emailHash = (email: string) => blindIndex(`email:${email.trim().toLowerCase()}`);

const MAX_ATTEMPTS = 3;
type SmtpError = { responseCode?: number; code?: string; rejected?: unknown[] };
/** Only a 5xx answer to the recipient itself (RCPT TO) means the mailbox is dead. */
const isBounce = (err: unknown) => {
  const e = err as SmtpError;
  return e.code === 'EENVELOPE' && (e.responseCode ?? 0) >= 500 && (e.rejected?.length ?? 0) > 0;
};
/** Login, connection or sender refusals are the club's setup, not the member's address: pause the queue. */
const isSetupError = (err: unknown) => {
  const e = err as SmtpError;
  return ['EAUTH', 'ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ETLS'].includes(e.code ?? '') || (e.code === 'EENVELOPE' && (e.responseCode ?? 0) >= 500 && !e.rejected?.length);
};

/**
 * Sends due deliveries, oldest first, within the club's per-minute rate (counted in the database, so it holds
 * across instances). Rows are claimed with SKIP LOCKED and `claimed_at`; a claim older than 10 minutes counts as
 * crashed and is retried. Delivery is at-least-once: a crash between SMTP accept and the status update resends.
 */
export async function processQueue(db: Db, opts: { baseUrl?: string; limit?: number } = {}) {
  // shortcut: one club per install, so one rate limit and one pause switch; per-tenant limits come with multi-tenant hosting.
  const org = await db.selectFrom('organization').select(['id', 'mail_per_minute', 'mail_paused_reason']).executeTakeFirst();
  if (!org || org.mail_paused_reason) return 0;
  const sentLastMinute = await db.selectFrom('delivery').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', org.id).where('status', '=', 'sent').where('sent_at', '>', sql<Date>`now() - interval '1 minute'`).executeTakeFirstOrThrow();
  const budget = Math.min(opts.limit ?? 30, org.mail_per_minute - sentLastMinute.n);
  if (budget <= 0) return 0;

  const claimed = await db.transaction().execute(async (tx) => {
    // Rows that crashed past their last attempt are given up instead of retried forever.
    await tx.updateTable('delivery').set({ status: 'failed', error: 'Versand abgebrochen (zu viele Versuche).' }).where('status', '=', 'sending').where('attempts', '>=', MAX_ATTEMPTS).where('claimed_at', '<', sql<Date>`now() - interval '10 minutes'`).execute();
    const rows = await sql<{ id: string }>`
      select d.id from delivery d
      where (d.status = 'queued' and d.next_attempt_at <= now())
         or (d.status = 'sending' and d.claimed_at < now() - interval '10 minutes')
      order by d.next_attempt_at
      limit ${budget}
      for update skip locked`.execute(tx);
    if (rows.rows.length === 0) return [];
    await tx.updateTable('delivery').set((eb) => ({ status: 'sending', claimed_at: new Date(), attempts: eb('attempts', '+', 1) })).where('id', 'in', rows.rows.map((r) => r.id)).execute();
    return rows.rows.map((r) => r.id);
  });

  for (const id of claimed) {
    try {
      await sendOne(db, id, opts.baseUrl);
    } catch (err) {
      // Anything unexpected before the SMTP call (database, PDF): back off and retry instead of leaving the row hanging.
      await db.updateTable('delivery').set({ status: 'queued', error: String((err as Error).message).slice(0, 300), next_attempt_at: sql<Date>`now() + interval '5 minutes'` }).where('id', '=', id).where('status', '=', 'sending').execute();
    }
  }
  return claimed.length;
}

async function sendOne(db: Db, id: string, baseUrl: string | undefined) {
  const d = await db
    .selectFrom('delivery')
    .innerJoin('message', 'message.id', 'delivery.message_id')
    .innerJoin('organization', 'organization.id', 'delivery.organization_id')
    .innerJoin('person', 'person.id', 'delivery.person_id')
    .leftJoin('member', 'member.id', 'delivery.member_id')
    .select([
      'delivery.id', 'delivery.email', 'delivery.attempts', 'delivery.invoice_id', 'delivery.donation_receipt_id', 'delivery.organization_id', 'delivery.message_id',
      'message.subject', 'message.body', 'message.category', 'message.recipient_filter',
      'organization.name as org_name', 'organization.mail_from_name', 'organization.mail_from_address', 'organization.mail_reply_to',
      'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.custom', 'member.membership_number',
    ])
    .where('delivery.id', '=', id)
    .executeTakeFirstOrThrow();
  const done = async (set: { status: 'sent' | 'failed' | 'bounced' | 'skipped' | 'queued'; error: string | null; sent_at?: Date; provider_id?: string | null; next_attempt_at?: unknown }) => {
    await db.updateTable('delivery').set(set as never).where('id', '=', id).execute();
    await finishMessage(db, d.message_id);
  };

  // Things change while a long queue drains: re-check suppression and the invoice right before sending.
  const reasons: ('bounce' | 'manual' | 'unsubscribe')[] = d.category === 'newsletter' ? ['bounce', 'manual', 'unsubscribe'] : ['bounce', 'manual'];
  const blocked = await db.selectFrom('suppression').select('reason').where('organization_id', '=', d.organization_id).where('email_hash', '=', emailHash(d.email)).where('reason', 'in', reasons).executeTakeFirst();
  if (blocked) return done({ status: 'skipped', error: blocked.reason === 'unsubscribe' ? 'inzwischen abgemeldet' : 'Adresse inzwischen gesperrt' });

  const values: PlaceholderValues = {
    vorname: d.first_name ?? d.company_name ?? '',
    nachname: d.last_name ?? '',
    name: d.kind === 'organisation' ? (d.company_name ?? '') : [d.first_name, d.last_name].filter(Boolean).join(' '),
    mitgliedsnummer: d.membership_number ?? '',
    verein: d.org_name,
    ...customPlaceholders(await db.selectFrom('custom_field').select(['id', 'key', 'type', 'sensitive']).where('organization_id', '=', d.organization_id).where('archived_at', 'is', null).execute(), d.custom),
  };
  const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  if (d.invoice_id) {
    const inv = await db.selectFrom('invoice').select(['number', 'status', 'total_cents', 'paid_cents', 'due_date']).where('id', '=', d.invoice_id).executeTakeFirstOrThrow();
    const dunning = (d.recipient_filter as { template?: string } | null)?.template === 'dunning';
    if (inv.status === 'cancelled') return done({ status: 'skipped', error: 'Rechnung inzwischen storniert' });
    if (dunning && !['open', 'partially_paid'].includes(inv.status)) return done({ status: 'skipped', error: 'Rechnung inzwischen bezahlt oder ausgebucht' });
    const dun = await db.selectFrom('dunning_event').select('label').where('invoice_id', '=', d.invoice_id).orderBy('level', 'desc').executeTakeFirst();
    const eur = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    values.rechnungsnummer = inv.number ?? '';
    values.betrag = eur(inv.total_cents);
    values.offen = eur(inv.total_cents - inv.paid_cents);
    values.faellig = inv.due_date ? inv.due_date.split('-').reverse().join('.') : '';
    values.mahnstufe = dun?.label ?? 'Zahlungserinnerung';
    const { pdf, number } = await storedPdf(db, d.organization_id, d.invoice_id);
    attachments.push({ filename: `${number}.pdf`, content: pdf, contentType: 'application/pdf' });
    // E-invoice recipients get the XRechnung next to the PDF; the XML is the legally relevant document for them.
    const e = await db.selectFrom('invoice_einvoice').select('xml').where('invoice_id', '=', d.invoice_id).executeTakeFirst();
    if (e) attachments.push({ filename: `${number}.xml`, content: decryptBytes(e.xml), contentType: 'application/xml' });
  }
  if (d.donation_receipt_id) {
    const r = await db.selectFrom('donation_receipt').select(['number', 'status', 'total_cents', 'pdf']).where('id', '=', d.donation_receipt_id).executeTakeFirstOrThrow();
    if (r.status !== 'issued') return done({ status: 'skipped', error: 'Bestätigung inzwischen storniert' });
    values.bestaetigung = r.number;
    values.betrag = (Number(r.total_cents) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    attachments.push({ filename: `${r.number}.pdf`, content: r.pdf, contentType: 'application/pdf' });
  }
  let text = fill(d.body, values);
  const unsubscribe = d.category === 'newsletter' && baseUrl ? `${baseUrl}/abmelden#${unsubscribeToken(d.id)}` : null;
  if (unsubscribe) text += `\n\n--\nDu möchtest diese Rundschreiben nicht mehr bekommen? Abmelden: ${unsubscribe}`;
  const sender = senderOf({ name: d.org_name, mail_from_name: d.mail_from_name, mail_from_address: d.mail_from_address, mail_reply_to: d.mail_reply_to });

  let info: { messageId?: string };
  try {
    info = await mailer().sendMail({
      from: { name: sender.name, address: sender.address },
      replyTo: sender.replyTo ?? undefined,
      to: d.email,
      subject: fill(d.subject, values),
      text,
      html: textToHtml(text),
      attachments,
      headers: unsubscribe ? { 'List-Unsubscribe': `<${baseUrl}/api/v1/unsubscribe/${unsubscribeToken(d.id)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    });
  } catch (err) {
    const message = String((err as Error).message).slice(0, 500);
    if (isBounce(err)) {
      await db.insertInto('suppression').values({ organization_id: d.organization_id, email_hash: emailHash(d.email), reason: 'bounce' }).onConflict((oc) => oc.doNothing()).execute();
      return done({ status: 'bounced', error: message });
    }
    if (isSetupError(err)) {
      // This attempt does not count; every send waits until an admin fixes the setup and resumes.
      await db.updateTable('delivery').set({ status: 'queued', error: message, attempts: sql<number>`attempts - 1` }).where('id', '=', id).execute();
      await db.updateTable('organization').set({ mail_paused_reason: message }).where('id', '=', d.organization_id).execute();
      return;
    }
    // Backoff 2, 4, 8 … minutes: greylisting and "421 slow down" need time, not speed.
    return done({ status: d.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', error: message, next_attempt_at: sql<Date>`now() + make_interval(mins => ${2 ** d.attempts})` });
  }
  // Sent: a failure from here on must not make the row look unsent, so only log it.
  await done({ status: 'sent', sent_at: new Date(), provider_id: info.messageId ?? null, error: null }).catch((err: unknown) => console.error('delivery status update failed after send', id, err));
}

async function finishMessage(db: Db, messageId: string) {
  await sql`update message set status = 'sent', finished_at = now()
    where id = ${messageId} and status = 'sending'
      and not exists (select 1 from delivery where message_id = ${messageId} and status in ('queued', 'sending'))`.execute(db);
}

/** Background loop every 5 seconds; the per-minute budget is enforced inside processQueue. */
export function startMailWorker(db: Db, baseUrl: string, log: (err: unknown) => void) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processQueue(db, { baseUrl });
    } catch (err) {
      log(err);
    } finally {
      running = false;
    }
  };
  return setInterval(() => void tick(), 5_000).unref();
}
