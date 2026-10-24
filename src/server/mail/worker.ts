import { sql } from 'kysely';
import { fill, textToHtml, type PlaceholderValues } from '../../shared/mail.ts';
import { blindIndex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { storedPdf } from '../invoices/service.ts';
import { mailer, senderOf } from './transport.ts';

export const unsubscribeToken = (deliveryId: string) => `${deliveryId}.${blindIndex(`unsubscribe:${deliveryId}`).slice(0, 32)}`;
export function deliveryFromToken(token: string) {
  const [id, mac] = token.split('.');
  return id && mac && unsubscribeToken(id) === token ? id : null;
}
export const emailHash = (email: string) => blindIndex(`email:${email.trim().toLowerCase()}`);

const MAX_ATTEMPTS = 3;
// 5xx SMTP replies are permanent: the address does not exist or the relay refuses it.
const isPermanent = (err: unknown) => {
  const code = (err as { responseCode?: number }).responseCode;
  return typeof code === 'number' && code >= 500;
};

/**
 * Sends queued deliveries, oldest first, at most `mail_per_minute` per club per call window.
 * Deliveries are claimed with SKIP LOCKED, so several app instances never send one mail twice.
 * Returns how many were processed.
 */
export async function processQueue(db: Db, opts: { baseUrl?: string; limit?: number } = {}) {
  const claimed = await db.transaction().execute(async (tx) => {
    const rows = await sql<{ id: string }>`
      select d.id from delivery d
      where d.status = 'queued' or (d.status = 'sending' and d.created_at < now() - interval '10 minutes')
      order by d.created_at
      limit ${opts.limit ?? 30}
      for update skip locked`.execute(tx);
    if (rows.rows.length === 0) return [];
    await tx.updateTable('delivery').set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1) })).where('id', 'in', rows.rows.map((r) => r.id)).execute();
    return rows.rows.map((r) => r.id);
  });

  for (const id of claimed) {
    const d = await db
      .selectFrom('delivery')
      .innerJoin('message', 'message.id', 'delivery.message_id')
      .innerJoin('organization', 'organization.id', 'delivery.organization_id')
      .innerJoin('person', 'person.id', 'delivery.person_id')
      .leftJoin('member', 'member.id', 'delivery.member_id')
      .select([
        'delivery.id', 'delivery.email', 'delivery.attempts', 'delivery.invoice_id', 'delivery.organization_id', 'delivery.message_id',
        'message.subject', 'message.body', 'message.category',
        'organization.name as org_name', 'organization.mail_from_name', 'organization.mail_from_address', 'organization.mail_reply_to',
        'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'member.membership_number',
      ])
      .where('delivery.id', '=', id)
      .executeTakeFirstOrThrow();
    try {
      const values: PlaceholderValues = {
        vorname: d.first_name ?? d.company_name ?? '',
        nachname: d.last_name ?? '',
        name: d.kind === 'organisation' ? (d.company_name ?? '') : [d.first_name, d.last_name].filter(Boolean).join(' '),
        mitgliedsnummer: d.membership_number ?? '',
        verein: d.org_name,
      };
      const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
      if (d.invoice_id) {
        const inv = await db.selectFrom('invoice').select(['number', 'total_cents', 'paid_cents', 'due_date']).where('id', '=', d.invoice_id).executeTakeFirstOrThrow();
        const dun = await db.selectFrom('dunning_event').select('label').where('invoice_id', '=', d.invoice_id).orderBy('level', 'desc').executeTakeFirst();
        const eur = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
        values.rechnungsnummer = inv.number ?? '';
        values.betrag = eur(inv.total_cents);
        values.offen = eur(inv.total_cents - inv.paid_cents);
        values.faellig = inv.due_date ? inv.due_date.split('-').reverse().join('.') : '';
        values.mahnstufe = dun?.label ?? 'Zahlungserinnerung';
        const { pdf, number } = await storedPdf(db, d.organization_id, d.invoice_id);
        attachments.push({ filename: `${number}.pdf`, content: pdf, contentType: 'application/pdf' });
      }
      let text = fill(d.body, values);
      if (d.category === 'newsletter' && opts.baseUrl) {
        text += `\n\n--\nDu möchtest diese Rundschreiben nicht mehr bekommen? Abmelden: ${opts.baseUrl}/abmelden#${unsubscribeToken(d.id)}`;
      }
      const sender = senderOf({ name: d.org_name, mail_from_name: d.mail_from_name, mail_from_address: d.mail_from_address, mail_reply_to: d.mail_reply_to });
      const info = await mailer().sendMail({
        from: { name: sender.name, address: sender.address },
        replyTo: sender.replyTo ?? undefined,
        to: d.email,
        subject: fill(d.subject, values),
        text,
        html: textToHtml(text),
        attachments,
        headers: d.category === 'newsletter' && opts.baseUrl ? { 'List-Unsubscribe': `<${opts.baseUrl}/abmelden#${unsubscribeToken(d.id)}>` } : undefined,
      });
      await db.updateTable('delivery').set({ status: 'sent', sent_at: new Date(), provider_id: info.messageId ?? null, error: null }).where('id', '=', id).execute();
    } catch (err) {
      const permanent = isPermanent(err);
      const final = permanent || d.attempts >= MAX_ATTEMPTS;
      await db.updateTable('delivery').set({ status: final ? (permanent ? 'bounced' : 'failed') : 'queued', error: String((err as Error).message).slice(0, 500) }).where('id', '=', id).execute();
      // A hard bounce suppresses the address for every later mail.
      if (permanent) {
        await db.insertInto('suppression').values({ organization_id: d.organization_id, email_hash: emailHash(d.email), reason: 'bounce' }).onConflict((oc) => oc.doNothing()).execute();
      }
    }
    await finishMessage(db, d.message_id);
  }
  return claimed.length;
}

async function finishMessage(db: Db, messageId: string) {
  await sql`update message set status = 'sent', finished_at = now()
    where id = ${messageId} and status = 'sending'
      and not exists (select 1 from delivery where message_id = ${messageId} and status in ('queued', 'sending'))`.execute(db);
}

/** Background loop: every few seconds, respecting the club's rate limit (default 60 per minute). */
export function startMailWorker(db: Db, baseUrl: string, log: (err: unknown) => void) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const org = await db.selectFrom('organization').select('mail_per_minute').executeTakeFirst();
      // shortcut: one club per install, so one rate limit; per-tenant limits come with multi-tenant hosting.
      await processQueue(db, { baseUrl, limit: Math.max(1, Math.round((org?.mail_per_minute ?? 60) / 12)) });
    } catch (err) {
      log(err);
    } finally {
      running = false;
    }
  };
  return setInterval(() => void tick(), 5_000).unref();
}
