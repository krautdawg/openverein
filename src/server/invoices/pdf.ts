import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { correction, generate } from 'lean-qr';
import { formatDate } from '../../shared/dates.ts';

const require = createRequire(import.meta.url);
// Source Sans 3 (SIL OFL) covers Latin Extended, so names like "Yılmaz" render correctly.
export const FONT = require.resolve('source-sans/TTF/SourceSans3-Regular.ttf');
export const FONT_BOLD = require.resolve('source-sans/TTF/SourceSans3-Semibold.ttf');

export interface PdfInvoice {
  title: string;
  number: string;
  issueDate: string;
  dueDate: string | null;
  membershipNumber: string | null;
  recipientLines: string[];
  coverText: string | null;
  closingText?: string | null;
  lines: { text: string; quantity: number; unitCents: number; totalCents: number; taxRate: number }[];
  totalCents: number;
  /** negative documents (cancellation, credit note) print amounts with a minus sign */
  negative: boolean;
  paymentText: string;
  /** EPC QR payload (GiroCode) or null */
  epc: string | null;
  org: { name: string; street: string | null; postalCode: string | null; city: string | null; email: string | null; iban: string | null; bic: string | null; bankName: string | null };
  demo: boolean;
}

const mm = (v: number) => (v * 72) / 25.4;
const money = (c: number, negative = false) => ((negative ? -c : c) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
export const formatIban = (iban: string) => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/**
 * EPC QR code payload (GiroCode, BCD version 002, UTF-8, SEPA credit transfer).
 * The remittance text is unstructured and limited to 140 characters.
 */
export function epcPayload(o: { name: string; iban: string; bic?: string | null; amountCents: number; remittance: string }) {
  return ['BCD', '002', '1', 'SCT', o.bic ?? '', o.name.slice(0, 70), o.iban.replace(/\s+/g, ''), `EUR${(o.amountCents / 100).toFixed(2)}`, '', '', o.remittance.slice(0, 140)].join('\n');
}

/** Renders an invoice-like document on a DIN 5008 letter layout (window envelope, form B). */
export function renderInvoicePdf(d: PdfInvoice): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: mm(20), left: mm(25), right: mm(20), bottom: mm(20) }, info: { Title: `${d.title} ${d.number}`, Author: d.org.name } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = mm(25);
  const right = doc.page.width - mm(20);
  const width = right - left;
  const ink = '#14202e';
  const muted = '#5f6874';

  if (d.demo) {
    doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('bold').fontSize(80).fillColor('#f2c230').opacity(0.25)
      .text('DEMO', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' }).restore().opacity(1);
  }

  // Letterhead: club name top right.
  doc.font('bold').fontSize(13).fillColor(ink).text(d.org.name, left, mm(15), { width, align: 'right' });

  // Sender line above the address window (DIN 5008 form B: window from 45 mm).
  const sender = [d.org.name, d.org.street, [d.org.postalCode, d.org.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  doc.font('text').fontSize(7).fillColor(muted).text(sender, mm(20), mm(47), { width: mm(85), lineBreak: false, ellipsis: true });
  doc.font('text').fontSize(10).fillColor(ink).text(d.recipientLines.join('\n'), mm(20), mm(53), { width: mm(85) });

  // Info block on the right.
  const info: [string, string][] = [
    ['Nummer', d.number],
    ['Datum', formatDate(d.issueDate)],
    ...(d.dueDate ? ([['Fällig am', formatDate(d.dueDate)]] as [string, string][]) : []),
    ...(d.membershipNumber ? ([['Mitgliedsnummer', d.membershipNumber]] as [string, string][]) : []),
  ];
  let y = mm(50);
  for (const [k, v] of info) {
    doc.font('text').fontSize(9).fillColor(muted).text(k, mm(125), y, { width: mm(30) });
    doc.font('text').fontSize(9).fillColor(ink).text(v, mm(155), y, { width: right - mm(155), align: 'right' });
    y += 13;
  }

  // Title and cover text.
  doc.font('bold').fontSize(15).fillColor(ink).text(`${d.title} ${d.number}`, left, mm(103), { width });
  doc.moveDown(0.6);
  if (d.coverText) doc.font('text').fontSize(10).fillColor(ink).text(d.coverText, { width }).moveDown(0.8);

  // Lines.
  const cols = { pos: left, text: left + 22, qty: right - 190, unit: right - 130, total: right - 70 };
  const header = (yy: number) => {
    doc.font('bold').fontSize(8.5).fillColor(muted);
    doc.text('Pos.', cols.pos, yy).text('Beschreibung', cols.text, yy).text('Menge', cols.qty, yy, { width: 50, align: 'right' }).text('Einzelpreis', cols.unit, yy, { width: 60, align: 'right' }).text('Betrag', cols.total, yy, { width: 70, align: 'right' });
    doc.moveTo(left, yy + 13).lineTo(right, yy + 13).lineWidth(0.5).strokeColor('#b4b9b0').stroke();
    return yy + 18;
  };
  y = header(doc.y + 4);
  d.lines.forEach((l, i) => {
    const h = Math.max(doc.font('text').fontSize(9.5).heightOfString(l.text, { width: cols.qty - cols.text - 8 }), 12);
    if (y + h > doc.page.height - mm(60)) {
      doc.addPage();
      y = header(mm(20));
    }
    doc.font('text').fontSize(9.5).fillColor(ink);
    doc.text(String(i + 1), cols.pos, y);
    doc.text(l.text, cols.text, y, { width: cols.qty - cols.text - 8 });
    doc.text(l.quantity.toLocaleString('de-DE'), cols.qty, y, { width: 50, align: 'right' });
    doc.text(money(l.unitCents, d.negative), cols.unit, y, { width: 60, align: 'right' });
    doc.text(money(l.totalCents, d.negative), cols.total, y, { width: 70, align: 'right' });
    y += h + 6;
  });
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor('#b4b9b0').stroke();
  y += 6;
  doc.font('bold').fontSize(10.5).fillColor(ink).text('Gesamt', cols.unit - 60, y, { width: 120, align: 'right' }).text(money(d.totalCents, d.negative), cols.total, y, { width: 70, align: 'right' });
  y += 16;
  const taxes = new Map<number, number>();
  for (const l of d.lines) if (l.taxRate > 0) taxes.set(l.taxRate, (taxes.get(l.taxRate) ?? 0) + Math.round((l.totalCents * l.taxRate) / (100 + l.taxRate)));
  doc.font('text').fontSize(8.5).fillColor(muted);
  if (taxes.size === 0) {
    doc.text('Im Gesamtbetrag ist keine Umsatzsteuer enthalten.', left, y, { width });
  } else {
    for (const [rate, tax] of taxes) {
      doc.text(`Darin enthalten ${rate} % USt: ${money(tax, d.negative)}`, left, y, { width, align: 'right' });
      y += 11;
    }
  }

  // Payment block with GiroCode.
  y = Math.max(doc.y + 18, y + 18);
  if (y > doc.page.height - mm(75)) {
    doc.addPage();
    y = mm(20);
  }
  const qrSize = mm(32);
  doc.font('text').fontSize(10).fillColor(ink).text(d.paymentText, left, y, { width: d.epc ? width - qrSize - 16 : width });
  if (d.epc) {
    // EPC069-12 requires error correction level M.
    const code = generate(d.epc, { minCorrectionLevel: correction.M });
    const cell = qrSize / (code.size + 8);
    const ox = right - qrSize;
    for (let qy = 0; qy < code.size; qy++) for (let qx = 0; qx < code.size; qx++) if (code.get(qx, qy)) doc.rect(ox + (qx + 4) * cell, y + (qy + 4) * cell, cell + 0.01, cell + 0.01);
    doc.fillColor('#000').fill();
    doc.font('text').fontSize(7).fillColor(muted).text('Mit der Banking-App scannen (GiroCode)', ox - 10, y + qrSize, { width: qrSize + 20, align: 'center' });
  }
  if (d.closingText) doc.font('text').fontSize(10).fillColor(ink).text(d.closingText, left, Math.max(doc.y, d.epc ? y + qrSize + 14 : doc.y) + 14, { width });

  // Footer on every page.
  const footer = [
    [d.org.name, d.org.street, [d.org.postalCode, d.org.city].filter(Boolean).join(' '), d.org.email].filter(Boolean).join(' · '),
    [d.org.bankName, d.org.iban && `IBAN ${formatIban(d.org.iban)}`, d.org.bic && `BIC ${d.org.bic}`].filter(Boolean).join(' · '),
  ].filter(Boolean);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('text').fontSize(7.5).fillColor(muted).text(footer.join('\n'), left, doc.page.height - mm(18), { width, align: 'center', lineBreak: true, height: mm(12) });
  }
  doc.end();
  return done;
}
