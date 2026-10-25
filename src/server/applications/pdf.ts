import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { MANDATE_TEXT, type ApplicationData } from '../../shared/applications.ts';
import { formatDate } from '../../shared/dates.ts';
import { formatIban } from '../invoices/pdf.ts';

const require = createRequire(import.meta.url);
const FONT = require.resolve('source-sans/TTF/SourceSans3-Regular.ttf');
const FONT_BOLD = require.resolve('source-sans/TTF/SourceSans3-Semibold.ttf');
const mm = (v: number) => (v * 72) / 25.4;

/** Copy of an application for the applicant; with a mandate it carries the mandate text and a signature line. */
export function applicationPdf(o: { club: string; creditorId: string | null; submittedAt: Date; data: ApplicationData; groups: string[]; feePlan: string | null; consentText: string; mandatePending: boolean }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: mm(20), left: mm(25), right: mm(20), bottom: mm(20) }, info: { Title: `Aufnahmeantrag ${o.data.firstName} ${o.data.lastName}`, Author: o.club } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const d = o.data;
  doc.font('bold').fontSize(16).text(`Aufnahmeantrag ${o.club}`);
  doc.font('text').fontSize(9).fillColor('#47525f').text(`Eingegangen am ${o.submittedAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`).fillColor('#14202e').moveDown(1.2);
  const row = (label: string, value: string | null | undefined) => {
    if (!value) return;
    const y = doc.y;
    doc.font('text').fontSize(9).fillColor('#47525f').text(label, mm(25), y, { width: mm(45) });
    doc.font('text').fontSize(11).fillColor('#14202e').text(value, mm(72), y, { width: mm(110) });
    doc.moveDown(0.4);
  };
  row('Name', `${d.firstName} ${d.lastName}`);
  row('Geboren am', formatDate(d.birthDate));
  row('Anschrift', `${d.street}, ${d.postalCode} ${d.city}`);
  row('E-Mail', d.email);
  row('Telefon', d.phone);
  row('Gruppen', o.groups.join(', '));
  row('Beitrag', o.feePlan);
  if (d.guardian) row('Erziehungsberechtigt', `${d.guardian.name}, ${d.guardian.email}${d.guardian.phone ? `, ${d.guardian.phone}` : ''}`);
  row('Anmerkung', d.note);
  doc.moveDown(0.8).font('bold').fontSize(11).text('Einwilligung', mm(25)).font('text').fontSize(9).text(o.consentText, { width: mm(160) });
  if (d.mandate) {
    doc.moveDown(1).font('bold').fontSize(11).text('SEPA-Lastschriftmandat', mm(25));
    doc.font('text').fontSize(9).text(MANDATE_TEXT(o.club, o.creditorId), { width: mm(160) }).moveDown(0.5);
    row('Kontoinhaber:in', d.mandate.accountHolder);
    row('IBAN', formatIban(d.mandate.iban));
    if (o.mandatePending) {
      doc.moveDown(2.5);
      const y = doc.y;
      doc.moveTo(mm(25), y).lineTo(mm(95), y).moveTo(mm(110), y).lineTo(mm(185), y).lineWidth(0.5).stroke('#14202e');
      doc.font('text').fontSize(8).text('Ort, Datum', mm(25), y + 3).text('Unterschrift Kontoinhaber:in', mm(110), y + 3);
      doc.moveDown(1).fontSize(9).text('Bitte unterschreiben und beim Verein abgeben. Erst dann ziehen wir Beiträge per Lastschrift ein.', mm(25), undefined, { width: mm(160) });
    }
  }
  doc.end();
  return done;
}
