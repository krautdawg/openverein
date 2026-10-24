import type { BankTx } from './camt.ts';

/** Parses one CSV line with quotes ("a;""b"";c"). */
function splitLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const COLUMNS = {
  date: ['buchungstag', 'buchungsdatum', 'datum', 'buchung'],
  valueDate: ['valuta', 'wertstellung', 'valutadatum'],
  amount: ['betrag', 'umsatz', 'betrag (eur)', 'betrag in eur', 'betrag (€)'],
  name: ['beguenstigter/zahlungspflichtiger', 'begünstigter/zahlungspflichtiger', 'name zahlungsbeteiligter', 'auftraggeber/empfänger', 'auftraggeber / begünstigter', 'zahlungsempfänger', 'empfänger', 'zahlungspflichtiger', 'name'],
  iban: ['kontonummer/iban', 'iban zahlungsbeteiligter', 'iban', 'kontonummer', 'iban auftraggeber'],
  purpose: ['verwendungszweck', 'buchungstext verwendungszweck', 'vorgang/verwendungszweck', 'zweck'],
  e2e: ['kundenreferenz (end-to-end)', 'end-to-end-referenz', 'end-to-end-id'],
  mandate: ['mandatsreferenz'],
};

const parseDate = (s: string) => {
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) return `${m[3]!.length === 2 ? '20' + m[3] : m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const parseAmount = (s: string) => {
  const t = s.replace(/\s|€|EUR/g, '');
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Bank CSV exports (Sparkasse, Volksbank, DKB, ING …): finds the header row, recognises the usual German
 * column names and reads German dates and amounts. Returns the transactions and the rows it skipped.
 */
export function parseBankCsv(content: string): { transactions: BankTx[]; skipped: number } {
  const text = content.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headerIndex = lines.findIndex((l) => /buchung|datum/i.test(l) && /betrag|umsatz/i.test(l));
  if (headerIndex < 0) throw new Error('Keine Kopfzeile mit Buchungsdatum und Betrag gefunden.');
  const sep = (lines[headerIndex]!.match(/;/g)?.length ?? 0) >= (lines[headerIndex]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = splitLine(lines[headerIndex]!, sep).map((h) => h.toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const idx = Object.fromEntries(Object.entries(COLUMNS).map(([k, v]) => [k, col(v)])) as Record<keyof typeof COLUMNS, number>;
  if (idx.date < 0 || idx.amount < 0) throw new Error('Die Spalten für Datum und Betrag wurden nicht erkannt.');
  const transactions: BankTx[] = [];
  let skipped = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    const c = splitLine(line, sep);
    const date = parseDate(c[idx.date] ?? '');
    const amount = parseAmount(c[idx.amount] ?? '');
    if (!date || amount === null) { skipped++; continue; }
    const at = (i: number) => (i >= 0 ? c[i] || null : null);
    transactions.push({
      bookingDate: date,
      valueDate: parseDate(at(idx.valueDate) ?? ''),
      amountCents: amount,
      counterpartyName: at(idx.name),
      counterpartyIban: at(idx.iban)?.replace(/\s+/g, '').toUpperCase() ?? null,
      remittance: at(idx.purpose) ?? '',
      endToEndId: at(idx.e2e),
      mandateId: at(idx.mandate),
      returnReason: /r(ü|ue)cklastschrift|retoure|r(ü|ue)ckgabe/i.test(at(idx.purpose) ?? '') && amount < 0 ? 'MS03' : null,
      bankReference: null,
    });
  }
  return { transactions, skipped };
}
