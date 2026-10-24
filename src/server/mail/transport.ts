import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.ts';

let transport: Transporter | null = null;

/** The club's SMTP relay from SMTP_URL (smtp://user:pass@host:port or smtps://…). */
export function mailer() {
  transport ??= nodemailer.createTransport(config.smtpUrl);
  return transport;
}

/** Tests replace the transport (e.g. with a failing one). */
export function setMailer(t: Transporter | null) {
  transport = t;
}

export interface Sender {
  name: string;
  address: string;
  replyTo: string | null;
}

export function senderOf(org: { name: string; mail_from_name: string | null; mail_from_address: string | null; mail_reply_to: string | null }): Sender {
  const fallback = config.mailFrom.match(/<([^>]+)>/)?.[1] ?? config.mailFrom;
  return { name: org.mail_from_name ?? org.name, address: org.mail_from_address ?? fallback, replyTo: org.mail_reply_to };
}
