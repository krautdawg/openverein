import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { formatDate } from '../../shared/dates.ts';
import { euroInWords } from '../../shared/words.ts';

const require = createRequire(import.meta.url);
const FONT = require.resolve('source-sans/TTF/SourceSans3-Regular.ttf');
const FONT_BOLD = require.resolve('source-sans/TTF/SourceSans3-Semibold.ttf');

/** Wording follows the BMF templates for money donations to § 5 Abs. 1 Nr. 9 KStG bodies; bump when it changes. */
export const RECEIPT_TEMPLATE = 'BMF-Muster Geldzuwendung (Stand 2023)';

export interface ReceiptPdf {
  number: string;
  issuedOn: string;
  donor: string[];
  items: { date: string; amountCents: number; waiver: boolean }[];
  org: { name: string; street: string | null; postalCode: string | null; city: string | null };
  exemption: { kind: 'freistellung' | 'feststellung'; office: string; taxNumber: string; date: string; period: string | null; purposes: string };
  signer: string | null;
  demo: boolean;
}

const mm = (v: number) => (v * 72) / 25.4;
const money = (c: number) => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

/** One page per receipt (collective receipts add an annex). Box layout after the official template. */
export function renderReceiptPdf(d: ReceiptPdf): Promise<Buffer> {
  const collective = d.items.length > 1;
  const total = d.items.reduce((s, i) => s + i.amountCents, 0);
  const doc = new PDFDocument({ size: 'A4', margins: { top: mm(18), left: mm(22), right: mm(20), bottom: mm(18) }, info: { Title: `Zuwendungsbestätigung ${d.number}`, Author: d.org.name } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const left = mm(22);
  const width = doc.page.width - mm(42);
  const ink = '#14202e';
  const muted = '#5f6874';
  const box = (label: string, value: string, x: number, y: number, w: number, h: number) => {
    doc.rect(x, y, w, h).lineWidth(0.6).strokeColor('#8a9097').stroke();
    doc.font('text').fontSize(7.5).fillColor(muted).text(label, x + 4, y + 3, { width: w - 8 });
    doc.font('bold').fontSize(10).fillColor(ink).text(value, x + 4, y + 13, { width: w - 8 });
  };
  const check = (on: boolean, x: number, y: number) => {
    doc.rect(x, y, 8, 8).lineWidth(0.6).strokeColor(ink).stroke();
    if (on) doc.font('bold').fontSize(9).fillColor(ink).text('X', x + 1.4, y - 1.2, { lineBreak: false });
    doc.font('text').fontSize(9).fillColor(ink);
  };
  if (d.demo) {
    doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('bold').fontSize(80).fillColor('#f2c230').opacity(0.25)
      .text('DEMO', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' }).restore().opacity(1);
  }

  const issuer = [d.org.name, d.org.street, [d.org.postalCode, d.org.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  doc.font('text').fontSize(8).fillColor(muted).text('Aussteller (Bezeichnung und Anschrift der steuerbegünstigten Einrichtung)', left, mm(18), { width });
  doc.font('bold').fontSize(10).fillColor(ink).text(issuer, { width });
  doc.moveDown(0.8);
  doc.font('bold').fontSize(12.5).text(collective ? 'Sammelbestätigung über Geldzuwendungen' : 'Bestätigung über Geldzuwendungen', { width });
  doc.font('text').fontSize(8.5).text('im Sinne des § 10b des Einkommensteuergesetzes an eine der in § 5 Abs. 1 Nr. 9 des Körperschaftsteuergesetzes bezeichneten Körperschaften, Personenvereinigungen oder Vermögensmassen', { width });
  doc.font('text').fontSize(8).fillColor(muted).text(`Nr. ${d.number}`, { width, align: 'right' });

  let y = doc.y + 8;
  box('Name und Anschrift des Zuwendenden', d.donor.join(', '), left, y, width, 34);
  y += 40;
  const third = width / 3;
  box(collective ? 'Gesamtbetrag der Zuwendung – in Ziffern –' : 'Betrag der Zuwendung – in Ziffern –', money(total), left, y, third - 4, 44);
  box('– in Buchstaben –', euroInWords(total), left + third, y, third - 4, 44);
  const dates = d.items.map((i) => i.date).sort();
  box(collective ? 'Zeitraum der Sammelbestätigung' : 'Tag der Zuwendung', collective ? `${formatDate(dates[0]!)} – ${formatDate(dates.at(-1)!)}` : formatDate(dates[0]!), left + 2 * third, y, third, 44);
  y += 54;

  doc.font('text').fontSize(9).fillColor(ink);
  if (collective) {
    doc.text('Ob es sich um den Verzicht auf Erstattung von Aufwendungen handelt, ist der Anlage zur Sammelbestätigung zu entnehmen.', left, y, { width });
  } else {
    doc.text('Es handelt sich um den Verzicht auf Erstattung von Aufwendungen', left, y, { continued: false });
    const waiver = d.items[0]!.waiver;
    check(waiver, left + mm(115), y + 1.5);
    doc.text('Ja', left + mm(119), y);
    check(!waiver, left + mm(130), y + 1.5);
    doc.text('Nein', left + mm(134), y);
  }
  y = doc.y + 10;

  const e = d.exemption;
  const purposes = e.purposes;
  check(e.kind === 'freistellung', left, y + 1.5);
  doc.text(
    `Wir sind wegen Förderung ${e.kind === 'freistellung' ? purposes : '…'} nach dem letzten uns zugegangenen Freistellungsbescheid bzw. nach der Anlage zum Körperschaftsteuerbescheid des Finanzamtes ${e.kind === 'freistellung' ? e.office : '…'}, StNr. ${e.kind === 'freistellung' ? e.taxNumber : '…'}, vom ${e.kind === 'freistellung' ? formatDate(e.date) : '…'} für den letzten Veranlagungszeitraum ${e.kind === 'freistellung' ? (e.period ?? '') : '…'} nach § 5 Abs. 1 Nr. 9 des Körperschaftsteuergesetzes von der Körperschaftsteuer und nach § 3 Nr. 6 des Gewerbesteuergesetzes von der Gewerbesteuer befreit.`,
    left + 14, y, { width: width - 14 },
  );
  y = doc.y + 8;
  check(e.kind === 'feststellung', left, y + 1.5);
  doc.text(
    `Die Einhaltung der satzungsmäßigen Voraussetzungen nach den §§ 51, 59, 60 und 61 AO wurde vom Finanzamt ${e.kind === 'feststellung' ? e.office : '…'}, StNr. ${e.kind === 'feststellung' ? e.taxNumber : '…'}, mit Bescheid vom ${e.kind === 'feststellung' ? formatDate(e.date) : '…'} nach § 60a AO gesondert festgestellt. Wir fördern nach unserer Satzung ${e.kind === 'feststellung' ? purposes : '…'}.`,
    left + 14, y, { width: width - 14 },
  );
  y = doc.y + 10;
  doc.text(`Es wird bestätigt, dass die Zuwendung nur zur Förderung ${purposes} verwendet wird.`, left, y, { width });
  y = doc.y + 8;
  doc.font('text').fontSize(8).fillColor(muted).text('Nur für steuerbegünstigte Einrichtungen, bei denen die Mitgliedsbeiträge steuerlich nicht abziehbar sind:', left, y, { width });
  y = doc.y + 3;
  check(true, left, y + 1.5);
  doc.font('text').fontSize(9).fillColor(ink).text('Es wird bestätigt, dass es sich nicht um Mitgliedsbeiträge handelt, deren Abzug nach § 10b Abs. 1 des Einkommensteuergesetzes ausgeschlossen ist.', left + 14, y, { width: width - 14 });
  if (collective) {
    y = doc.y + 8;
    doc.text('Es wird bestätigt, dass über die in der Gesamtsumme enthaltenen Zuwendungen keine weiteren Bestätigungen, weder formelle Zuwendungsbestätigungen noch Beitragsquittungen oder ähnliches ausgestellt wurden und werden.', left, y, { width });
  }

  y = doc.y + 30;
  doc.font('text').fontSize(10).fillColor(ink).text(`${d.org.city ?? ''}, ${formatDate(d.issuedOn)}${d.signer ? `    ${d.signer}` : ''}`, left, y, { width });
  doc.moveTo(left, doc.y + 2).lineTo(left + width * 0.7, doc.y + 2).lineWidth(0.5).strokeColor(ink).stroke();
  doc.font('text').fontSize(7.5).fillColor(muted).text('(Ort, Datum und Unterschrift des Zuwendungsempfängers)', left, doc.y + 5, { width });

  doc.moveDown(1.4);
  doc.font('bold').fontSize(7.5).fillColor(ink).text('Hinweis:', { width });
  doc.font('text').fontSize(7.5).fillColor(ink).text(
    'Wer vorsätzlich oder grob fahrlässig eine unrichtige Zuwendungsbestätigung erstellt oder veranlasst, dass Zuwendungen nicht zu den in der Zuwendungsbestätigung angegebenen steuerbegünstigten Zwecken verwendet werden, haftet für die entgangene Steuer (§ 10b Abs. 4 EStG, § 9 Abs. 3 KStG, § 9 Nr. 5 GewStG).',
    { width },
  );
  doc.moveDown(0.4).text(
    'Diese Bestätigung wird nicht als Nachweis für die steuerliche Berücksichtigung der Zuwendung anerkannt, wenn das Datum des Freistellungsbescheides länger als 5 Jahre bzw. das Datum der Feststellung der Einhaltung der satzungsmäßigen Voraussetzungen nach § 60a Abs. 1 AO länger als 3 Jahre seit Ausstellung des Bescheides zurückliegt (§ 63 Abs. 5 AO).',
    { width },
  );

  if (collective) {
    doc.addPage();
    doc.font('bold').fontSize(12).fillColor(ink).text(`Anlage zur Sammelbestätigung Nr. ${d.number}`, left, mm(20), { width });
    doc.font('text').fontSize(9).text(d.donor.join(', '), { width }).moveDown(0.8);
    const cols = [left, left + mm(35), left + mm(80), left + width - mm(30)];
    let ty = doc.y;
    doc.font('bold').fontSize(8.5).fillColor(muted);
    doc.text('Datum der Zuwendung', cols[0]!, ty).text('Art der Zuwendung', cols[1]!, ty).text('Verzicht auf Erstattung von Aufwendungen', cols[2]!, ty, { width: mm(55) }).text('Betrag', cols[3]!, ty, { width: mm(30), align: 'right' });
    ty = doc.y + 4;
    doc.font('text').fontSize(9.5).fillColor(ink);
    for (const i of [...d.items].sort((a, b) => a.date.localeCompare(b.date))) {
      if (ty > doc.page.height - mm(30)) {
        doc.addPage();
        ty = mm(20);
      }
      doc.text(formatDate(i.date), cols[0]!, ty).text('Geldzuwendung', cols[1]!, ty).text(i.waiver ? 'ja' : 'nein', cols[2]!, ty).text(money(i.amountCents), cols[3]!, ty, { width: mm(30), align: 'right' });
      ty += 15;
    }
    doc.moveTo(left, ty).lineTo(left + width, ty).lineWidth(0.5).strokeColor('#8a9097').stroke();
    doc.font('bold').text('Gesamtsumme', cols[2]!, ty + 5).text(money(total), cols[3]!, ty + 5, { width: mm(30), align: 'right' });
  }
  doc.end();
  return done;
}
