import PDFDocument from 'pdfkit';
import { FONT, FONT_BOLD } from '../invoices/pdf.ts';

export interface ListRow { number: string | null; name: string; groups: string; phone?: string | null; email?: string | null; address: string }

const mm = (v: number) => (v * 72) / 25.4;

/** Printable member list: A4 landscape, repeated header row, page numbers. Hidden fields are simply absent. */
export function memberListPdf(rows: ListRow[], o: { club: string; title: string; date: string; showPhone: boolean; showEmail: boolean; demo?: boolean }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: mm(15), left: mm(15), right: mm(15), bottom: mm(15) }, bufferPages: true, info: { Title: o.title, Author: o.club } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const cols = [
    { h: 'Nr.', w: 18, get: (r: ListRow) => r.number ?? '' },
    { h: 'Name', w: 52, get: (r: ListRow) => r.name },
    { h: 'Gruppen', w: 42, get: (r: ListRow) => r.groups },
    ...(o.showPhone ? [{ h: 'Telefon', w: 30, get: (r: ListRow) => r.phone ?? '' }] : []),
    ...(o.showEmail ? [{ h: 'E-Mail', w: 60, get: (r: ListRow) => r.email ?? '' }] : []),
    { h: 'Anschrift', w: 0, get: (r: ListRow) => r.address },
  ];
  const left = doc.page.margins.left;
  const full = doc.page.width - left - doc.page.margins.right;
  const fixed = cols.reduce((s, c) => s + mm(c.w), 0);
  const widths = cols.map((c) => (c.w ? mm(c.w) : Math.max(full - fixed, mm(40))));
  const line = (y: number) => doc.moveTo(left, y).lineTo(left + full, y).lineWidth(0.5).strokeColor('#d5dadd').stroke();
  const head = () => {
    doc.font('bold').fontSize(13).fillColor('#14202e').text(o.title, left, doc.page.margins.top);
    doc.font('text').fontSize(8).fillColor('#5f6874').text(`${o.club} · Stand ${o.date} · ${rows.length} Einträge`, left, doc.y + 2);
    let x = left;
    const y = doc.y + mm(4);
    doc.font('bold').fontSize(8).fillColor('#47525f');
    cols.forEach((c, i) => { doc.text(c.h, x, y, { width: widths[i]! - 4, lineBreak: false }); x += widths[i]!; });
    line(y + 12);
    return y + 16;
  };
  let y = head();
  doc.font('text').fontSize(9).fillColor('#14202e');
  for (const r of rows) {
    const h = Math.max(...cols.map((c, i) => doc.heightOfString(c.get(r), { width: widths[i]! - 4 }))) + 6;
    if (y + h > doc.page.height - doc.page.margins.bottom - 12) {
      doc.addPage();
      y = head();
      doc.font('text').fontSize(9).fillColor('#14202e');
    }
    let x = left;
    cols.forEach((c, i) => { doc.text(c.get(r), x, y, { width: widths[i]! - 4 }); x += widths[i]!; });
    y += h;
    line(y - 3);
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    if (o.demo) doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('bold').fontSize(90).fillColor('#f2c230').opacity(0.22).text('DEMO', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center', lineBreak: false }).restore().opacity(1);
    doc.font('text').fontSize(7).fillColor('#5f6874').text(`Seite ${i + 1} von ${range.count}`, left, doc.page.height - doc.page.margins.bottom, { width: full, align: 'right', lineBreak: false });
  }
  doc.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** vCard 4.0 (RFC 6350) text escaping. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

export interface Card { kind: string; firstName: string | null; lastName: string | null; companyName: string | null; email?: string | null; phone?: string | null; street: string | null; postalCode: string | null; city: string | null; country: string; birthDate?: string | null; org: string }

/** One vCard 4.0 per person; restricted fields are left out by the caller. */
export function vcard(c: Card) {
  const fn = c.kind === 'organisation' ? (c.companyName ?? '') : [c.firstName, c.lastName].filter(Boolean).join(' ');
  const lines = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    `FN:${esc(fn)}`,
    c.kind === 'organisation' ? 'KIND:org' : `N:${esc(c.lastName ?? '')};${esc(c.firstName ?? '')};;;`,
    c.email && `EMAIL:${esc(c.email)}`,
    c.phone && `TEL;VALUE=uri:tel:${c.phone.replace(/[^\d+]/g, '')}`,
    (c.street || c.city) && `ADR:;;${esc(c.street ?? '')};${esc(c.city ?? '')};;${esc(c.postalCode ?? '')};${esc(c.country)}`,
    c.birthDate && `BDAY:${c.birthDate.replace(/-/g, '')}`,
    `CATEGORIES:${esc(c.org)}`,
    'END:VCARD',
  ];
  return lines.filter(Boolean).join('\r\n');
}
