// DATEV "Buchungsstapel" in the EXTF format, version 700, category 21, format version 13.
// The journal already carries explicit tax lines, so rows go without BU keys: tax lines are separate postings to the
// mapped tax accounts. Sphere becomes KOST1 (1–4), the cost centre KOST2.

export interface DatevLine {
  entryNumber: number;
  date: string; // YYYY-MM-DD
  text: string;
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
  sphere: 'ideell' | 'vermoegen' | 'zweck' | 'wirtschaft';
  costCenter: string | null;
}

export interface DatevHeader {
  consultant: number;
  client: number;
  fiscalYearStart: string; // YYYY-MM-DD
  accountLength: number;
  from: string;
  to: string;
  createdAt: Date;
}

export const SPHERE_KOST1 = { ideell: '1', vermoegen: '2', zweck: '3', wirtschaft: '4' } as const;

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const ymd = (d: string) => d.replaceAll('-', '');

/** Pairs debit and credit lines of one entry into DATEV rows (one account against one counter-account each). */
export function pairLines(lines: { account: string; debitCents: number; creditCents: number; sphere: DatevLine['sphere']; costCenter: string | null; isMoney: boolean }[]) {
  const debits = lines.filter((l) => l.debitCents > 0).map((l) => ({ ...l, left: l.debitCents }));
  const credits = lines.filter((l) => l.creditCents > 0).map((l) => ({ ...l, left: l.creditCents }));
  const rows: { debitAccount: string; creditAccount: string; amountCents: number; sphere: DatevLine['sphere']; costCenter: string | null }[] = [];
  let d = 0;
  let c = 0;
  while (d < debits.length && c < credits.length) {
    const amount = Math.min(debits[d]!.left, credits[c]!.left);
    // The side that is not the money account carries the sphere and cost centre.
    const detail = debits[d]!.isMoney ? credits[c]! : debits[d]!;
    rows.push({ debitAccount: debits[d]!.account, creditAccount: credits[c]!.account, amountCents: amount, sphere: detail.sphere, costCenter: detail.costCenter });
    debits[d]!.left -= amount;
    credits[c]!.left -= amount;
    if (debits[d]!.left === 0) d++;
    if (credits[c]!.left === 0) c++;
  }
  return rows;
}

const COLUMNS = ['Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext', 'Postensperre', 'Diverse Adressnummer', 'Geschäftspartnerbank', 'Sachverhalt', 'Zinssperre', 'Beleglink', 'Beleginfo - Art 1', 'Beleginfo - Inhalt 1', 'Beleginfo - Art 2', 'Beleginfo - Inhalt 2', 'Beleginfo - Art 3', 'Beleginfo - Inhalt 3', 'Beleginfo - Art 4', 'Beleginfo - Inhalt 4', 'Beleginfo - Art 5', 'Beleginfo - Inhalt 5', 'Beleginfo - Art 6', 'Beleginfo - Inhalt 6', 'Beleginfo - Art 7', 'Beleginfo - Inhalt 7', 'Beleginfo - Art 8', 'Beleginfo - Inhalt 8', 'KOST1 - Kostenstelle', 'KOST2 - Kostenstelle'];

/** The CSV text (to be encoded as Windows-1252 with CRLF). */
export function buchungsstapel(h: DatevHeader, lines: DatevLine[]) {
  const created = h.createdAt.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const header = ['"EXTF"', '700', '21', q('Buchungsstapel'), '13', created, '', q('OV'), q(''), q(''), String(h.consultant), String(h.client), ymd(h.fiscalYearStart), String(h.accountLength), ymd(h.from), ymd(h.to), q('OpenVerein'), q(''), '1', '0', '0', q('EUR'), '', q(''), '', '', q(''), q(''), '', '', q('')];
  const rows = lines.map((l) => {
    const cells = new Array<string>(COLUMNS.length).fill('');
    cells[0] = (l.amountCents / 100).toFixed(2).replace('.', ',');
    cells[1] = q('S');
    cells[2] = q('EUR');
    cells[6] = l.debitAccount;
    cells[7] = l.creditAccount;
    cells[9] = l.date.slice(8, 10) + l.date.slice(5, 7);
    cells[10] = q(String(l.entryNumber).slice(0, 36));
    cells[13] = q(l.text.replace(/[\r\n]+/g, ' ').slice(0, 60));
    cells[36] = q(SPHERE_KOST1[l.sphere]);
    cells[37] = q((l.costCenter ?? '').slice(0, 36));
    return cells.join(';');
  });
  return [header.join(';'), COLUMNS.map(q).join(';'), ...rows].join('\r\n') + '\r\n';
}
