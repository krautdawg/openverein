import PDFDocument from 'pdfkit';
import { SPHERE_LABEL } from '../../shared/ledger.ts';
import { FONT, FONT_BOLD } from '../invoices/pdf.ts';

interface Input {
  club: string;
  year: number;
  euer: { spheres: { sphere: string; incomeCents: number; expenseCents: number; resultCents: number }[]; rows: { number: string; name: string; kind: 'income' | 'expense'; sphere: string; netCents: number }[]; totals: { incomeCents: number; expenseCents: number; resultCents: number }; warnings: { message: string }[] };
  money: { number: string; name: string; openingCents: number; closingCents: number }[];
}

const mm = (v: number) => (v * 72) / 25.4;
const euro = (c: number) => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

/** Treasurer's report for the general assembly: balances, result by sphere, income and expenses by account. */
export function treasurerReportPdf(d: Input): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: mm(20), left: mm(22), right: mm(20), bottom: mm(18) }, info: { Title: `Kassenbericht ${d.year}`, Author: d.club } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const left = mm(22);
  const width = doc.page.width - mm(42);
  const ink = '#14202e';
  const muted = '#5f6874';
  const row = (label: string, values: string[], bold = false) => {
    const y = doc.y;
    const colW = mm(32);
    doc.font(bold ? 'bold' : 'text').fontSize(9.5).fillColor(ink).text(label, left, y, { width: width - values.length * colW });
    const after = doc.y;
    values.forEach((v, i) => doc.text(v, left + width - (values.length - i) * colW, y, { width: colW, align: 'right' }));
    doc.y = Math.max(after, doc.y) + 2;
  };
  const head = (title: string, cols: string[]) => {
    doc.moveDown(0.8).font('bold').fontSize(12).fillColor(ink).text(title, left, doc.y, { width });
    doc.moveDown(0.3);
    const y = doc.y;
    doc.font('bold').fontSize(8).fillColor(muted);
    cols.forEach((c, i) => doc.text(c, left + width - (cols.length - i) * mm(32), y, { width: mm(32), align: 'right' }));
    doc.y = y + 12;
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.5).strokeColor('#d5dadd').stroke();
    doc.y += 4;
  };

  doc.font('text').fontSize(9).fillColor(muted).text(d.club, left, mm(20), { width });
  doc.moveDown(0.2).font('bold').fontSize(18).fillColor(ink).text(`Kassenbericht ${d.year}`, { width });
  doc.font('text').fontSize(9.5).fillColor(muted).text(`Einnahmen-Überschuss-Rechnung, 1. Januar bis 31. Dezember ${d.year}`, { width });

  head('Bestände', ['1. Januar', '31. Dezember']);
  for (const m of d.money) row(`${m.number} ${m.name}`, [euro(m.openingCents), euro(m.closingCents)]);
  row('Summe', [euro(d.money.reduce((s, m) => s + m.openingCents, 0)), euro(d.money.reduce((s, m) => s + m.closingCents, 0))], true);

  head('Ergebnis nach Sphären', ['Einnahmen', 'Ausgaben', 'Ergebnis']);
  for (const s of d.euer.spheres) row(SPHERE_LABEL[s.sphere as keyof typeof SPHERE_LABEL] ?? s.sphere, [euro(s.incomeCents), euro(s.expenseCents), euro(s.resultCents)]);
  row('Gesamt', [euro(d.euer.totals.incomeCents), euro(d.euer.totals.expenseCents), euro(d.euer.totals.resultCents)], true);

  for (const kind of ['income', 'expense'] as const) {
    head(kind === 'income' ? 'Einnahmen nach Konten' : 'Ausgaben nach Konten', ['Betrag']);
    const byAccount = new Map<string, number>();
    for (const r of d.euer.rows.filter((x) => x.kind === kind)) byAccount.set(`${r.number} ${r.name}`, (byAccount.get(`${r.number} ${r.name}`) ?? 0) + r.netCents);
    for (const [k, v] of byAccount) row(k, [euro(v)]);
  }

  if (d.euer.warnings.length) {
    doc.moveDown(0.8).font('bold').fontSize(10).fillColor('#8f5a00').text('Hinweise', left, doc.y, { width });
    for (const w of d.euer.warnings) doc.font('text').fontSize(9).fillColor(ink).text(`– ${w.message}`, { width });
  }
  doc.moveDown(2.5);
  const y = doc.y;
  doc.moveTo(left, y).lineTo(left + width * 0.45, y).lineWidth(0.5).strokeColor(ink).stroke();
  doc.font('text').fontSize(8).fillColor(muted).text('Ort, Datum, Kassenwart:in', left, y + 4, { width: width * 0.45 });
  doc.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
