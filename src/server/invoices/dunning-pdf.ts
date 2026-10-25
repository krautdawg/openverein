import PDFDocument from 'pdfkit';
import { formatDate } from '../../shared/dates.ts';
import type { Db } from '../db.ts';
import { orgToday } from '../members/query.ts';
import { FONT, FONT_BOLD, formatIban } from './pdf.ts';
import type { IssueSnapshot } from './service.ts';

const mm = (v: number) => (v * 72) / 25.4;
const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/**
 * A printed reminder for an open invoice at its latest dunning level: address in the DIN 5008 window, the open
 * amount, the dunning fee invoice if any, and how to pay. Rendered on demand (the reminder itself is the event log).
 */
export async function dunningLetterPdf(db: Db, organizationId: string, invoiceId: string): Promise<{ pdf: Buffer; postalCode: string; number: string }> {
  const today = await orgToday(db, organizationId);
  const inv = await db.selectFrom('invoice').selectAll().where('id', '=', invoiceId).where('organization_id', '=', organizationId).executeTakeFirstOrThrow();
  const org = await db.selectFrom('organization').selectAll().where('id', '=', organizationId).executeTakeFirstOrThrow();
  const dun = await db.selectFrom('dunning_event').leftJoin('invoice as fee', 'fee.id', 'dunning_event.fee_invoice_id').select(['dunning_event.label', 'dunning_event.fee_cents', 'fee.number as fee_number']).where('dunning_event.invoice_id', '=', invoiceId).orderBy('dunning_event.level', 'desc').executeTakeFirst();
  const snap = inv.recipient as IssueSnapshot;
  const open = Number(inv.total_cents) - Number(inv.paid_cents);
  const payBy = formatDate(new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10));
  const doc = new PDFDocument({ size: 'A4', margins: { top: mm(20), left: mm(25), right: mm(20), bottom: mm(20) }, info: { Title: `${dun?.label ?? 'Zahlungserinnerung'} ${inv.number}`, Author: org.name } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const left = mm(25);
  const width = doc.page.width - mm(45);
  const ink = '#14202e';
  const muted = '#5f6874';
  if (org.is_demo) doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('bold').fontSize(80).fillColor('#f2c230').opacity(0.25).text('DEMO', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' }).restore().opacity(1);
  doc.font('bold').fontSize(13).fillColor(ink).text(org.name, left, mm(15), { width, align: 'right' });
  const sender = [org.name, org.street, [org.postal_code, org.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  doc.font('text').fontSize(7).fillColor(muted).text(sender, mm(20), mm(47), { width: mm(85), lineBreak: false, ellipsis: true });
  doc.font('text').fontSize(10).fillColor(ink).text(snap.recipient.lines.join('\n'), mm(20), mm(53), { width: mm(85) });
  doc.font('text').fontSize(9).fillColor(muted).text(`${org.city ?? ''}, ${formatDate(today)}`, mm(125), mm(53), { width: width - mm(100), align: 'right' });
  doc.font('bold').fontSize(14).fillColor(ink).text(`${dun?.label ?? 'Zahlungserinnerung'} zur Rechnung ${inv.number}`, left, mm(100), { width });
  doc.moveDown(1).font('text').fontSize(10.5).fillColor(ink);
  const first = snap.recipient.name.split(' ')[0];
  doc.text(`Hallo ${first},`, { width });
  doc.moveDown(0.6).text(`unsere Rechnung ${inv.number} vom ${formatDate(inv.issue_date!)} über ${euro(Number(inv.total_cents))} war am ${inv.due_date ? formatDate(inv.due_date) : '…'} fällig. Bei uns sind davon noch ${euro(open)} offen.`, { width, lineGap: 2 });
  if (dun && Number(dun.fee_cents) > 0) doc.moveDown(0.6).text(`Für diese Mahnung berechnen wir ${euro(Number(dun.fee_cents))}${dun.fee_number ? ` (Rechnung ${dun.fee_number})` : ''}.`, { width });
  doc.moveDown(0.6).text(org.iban ? `Bitte überweise den offenen Betrag bis zum ${payBy} auf unser Konto ${formatIban(org.iban)}${org.bic ? ` (BIC ${org.bic})` : ''}. Verwendungszweck: ${inv.number}.` : `Bitte zahle den offenen Betrag bis zum ${payBy}. Verwendungszweck: ${inv.number}.`, { width, lineGap: 2 });
  doc.moveDown(0.6).text('Falls Du inzwischen bezahlt hast, betrachte dieses Schreiben bitte als gegenstandslos.', { width });
  doc.moveDown(1.2).text('Viele Grüße', { width });
  doc.text(org.name, { width });
  doc.end();
  const pdf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { pdf, number: inv.number!, postalCode: snap.recipient.lines.join(' ').match(/\b\d{5}\b/)?.[0] ?? '99999z' };
}
