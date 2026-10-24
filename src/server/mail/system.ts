import { fill, SYSTEM_TEMPLATES, textToHtml, type PlaceholderValues, type SystemTemplateKey } from '../../shared/mail.ts';
import type { Db } from '../db.ts';
import { mailer, senderOf } from './transport.ts';

/**
 * Sends one transactional mail right away (sign-in code, invitation, decisions) with the club's text for `key`.
 * Returns false when the relay refuses; callers decide whether that matters (the admin can hand out a code instead).
 */
export async function sendSystemMail(db: Db, organizationId: string, key: SystemTemplateKey, to: string, values: PlaceholderValues, attachments: { filename: string; content: Buffer; contentType: string }[] = []) {
  const org = await db.selectFrom('organization').selectAll().where('id', '=', organizationId).executeTakeFirstOrThrow();
  const own = await db.selectFrom('mail_template').select(['subject', 'body']).where('organization_id', '=', organizationId).where('key', '=', key).executeTakeFirst();
  const t = own ?? SYSTEM_TEMPLATES[key];
  const v = { verein: org.name, ...values };
  const sender = senderOf(org);
  const text = fill(t.body, v);
  try {
    await mailer().sendMail({ from: { name: sender.name, address: sender.address }, replyTo: sender.replyTo ?? undefined, to, subject: fill(t.subject, v), text, html: textToHtml(text), attachments });
    return true;
  } catch {
    return false;
  }
}
