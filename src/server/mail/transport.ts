import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.ts';

let transport: Transporter | null = null;

/** The club's SMTP relay from SMTP_URL (smtp://user:pass@host:port or smtps://…). */
export function mailer() {
  // Short timeouts: a dead relay must not hang a request (invitations) or the worker for minutes.
  const url = new URL(config.smtpUrl);
  for (const [k, v] of [['connectionTimeout', '10000'], ['greetingTimeout', '10000'], ['socketTimeout', '30000']] as const) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  // The public demo never sends real mail: messages are rendered and logged as delivered, nothing leaves the server.
  transport ??= config.demoMode ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport(url.toString());
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
  // Managed hosting: all clubs share the operator's mail server, so no club may send as an address of its choice
  // (it would pass SPF/DKIM for another club's domain). The operator's address sends, the club's address answers.
  if (config.multiTenant) return { name: org.mail_from_name ?? org.name, address: fallback, replyTo: org.mail_reply_to ?? org.mail_from_address };
  return { name: org.mail_from_name ?? org.name, address: org.mail_from_address ?? fallback, replyTo: org.mail_reply_to };
}
