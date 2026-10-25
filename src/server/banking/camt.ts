import { XMLParser } from 'fast-xml-parser';

/** One booked movement on the account, as the bank reports it. Amounts are signed cents. */
export interface BankTx {
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  remittance: string;
  endToEndId: string | null;
  mandateId: string | null;
  returnReason: string | null;
  bankReference: string | null;
}

export interface Statement {
  iban: string | null;
  openingCents: number | null;
  closingCents: number | null;
  from: string | null;
  to: string | null;
  transactions: BankTx[];
}

export const MAX_BYTES = 50 * 1024 * 1024;

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
type Node = Record<string, unknown>;
const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Node)[k] : undefined), o);
const text = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return text((v as Node)['#text']);
  const s = String(v).trim();
  return s === '' || s === 'NOTPROVIDED' ? null : s;
};
const cents = (amt: unknown) => Math.round(Number(text(amt)) * 100);
const dateOf = (d: unknown) => text(get(d, 'Dt')) ?? text(get(d, 'DtTm'))?.slice(0, 10) ?? null;

/**
 * Parses CAMT.053 (versions .001.02 to .001.08) without namespaces. DOCTYPE declarations are refused
 * before parsing and entities are never expanded, so XXE and entity bombs cannot work.
 */
export function parseCamt053(xml: string): Statement[] {
  if (Buffer.byteLength(xml) > MAX_BYTES) throw new Error('Die Datei ist größer als 50 MB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Die Datei enthält eine DOCTYPE- oder ENTITY-Deklaration und wird abgelehnt.');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, processEntities: false, parseTagValue: false, trimValues: true });
  const root = parser.parse(xml) as Node;
  const stmts = arr(get(root, 'Document', 'BkToCstmrStmt', 'Stmt'));
  if (stmts.length === 0) throw new Error('Keine CAMT.053-Kontoauszugsdaten gefunden.');

  return stmts.map((s) => {
    const balances = arr(get(s, 'Bal') as Node | Node[]);
    const bal = (code: string) => {
      const b = balances.find((x) => text(get(x, 'Tp', 'CdOrPrtry', 'Cd')) === code);
      if (!b) return null;
      const v = cents(get(b, 'Amt'));
      return text(get(b, 'CdtDbtInd')) === 'DBIT' ? -v : v;
    };
    const transactions: BankTx[] = [];
    for (const n of arr(get(s, 'Ntry') as Node | Node[])) {
      // Only booked entries count (pending and information entries are not on the account yet).
      // Missing, proprietary or unknown statuses are not treated as booked (Codex review of #4).
      const status = text(get(n, 'Sts', 'Cd')) ?? text(get(n, 'Sts'));
      if (status !== 'BOOK') continue;
      const ccy = (get(n, 'Amt') as Node | undefined)?.['@Ccy'];
      if (ccy && ccy !== 'EUR') throw new Error(`Der Auszug enthält Buchungen in ${String(ccy)}; OpenVerein kennt nur Euro.`);
      const sign = text(get(n, 'CdtDbtInd')) === 'DBIT' ? -1 : 1;
      const bookingDate = dateOf(get(n, 'BookgDt')) ?? dateOf(get(n, 'ValDt'));
      if (!bookingDate) continue;
      const details = arr(get(n, 'NtryDtls') as Node | Node[]).flatMap((d) => arr(get(d, 'TxDtls') as Node | Node[]));
      const detailAmount = (d: unknown) => get(d, 'AmtDtls', 'TxAmt', 'Amt') ?? get(d, 'Amt') ?? get(d, 'AmtDtls', 'InstdAmt', 'Amt');
      // Batch bookings are split into their single transactions only when the details add up to the entry.
      const split = details.length > 1 && details.every((d) => text(detailAmount(d)) !== null) && details.reduce((sum, d) => sum + cents(detailAmount(d)), 0) === cents(get(n, 'Amt'));
      // An aggregate that cannot be split keeps no single detail's identity (end-to-end ID, party, return reason):
      // the amount belongs to several movements, so it must not be matched as if it were one of them.
      const parts = split ? details : [details.length > 1 ? undefined : details[0]];
      for (const d of parts) {
        const amt = split ? detailAmount(d) : get(n, 'Amt');
        const party = sign > 0 ? 'Dbtr' : 'Cdtr';
        const p = get(d, 'RltdPties', party);
        transactions.push({
          bookingDate,
          valueDate: dateOf(get(n, 'ValDt')),
          amountCents: sign * cents(amt),
          counterpartyName: text(get(p, 'Pty', 'Nm')) ?? text(get(p, 'Nm')),
          counterpartyIban: text(get(d, 'RltdPties', `${party}Acct`, 'Id', 'IBAN'))?.replace(/\s+/g, '') ?? null,
          remittance: arr(get(d, 'RmtInf', 'Ustrd')).map((u) => text(u)).filter(Boolean).join(' ') || text(get(n, 'AddtlNtryInf')) || '',
          endToEndId: text(get(d, 'Refs', 'EndToEndId')),
          mandateId: text(get(d, 'Refs', 'MndtId')),
          returnReason: text(get(d, 'RtrInf', 'Rsn', 'Cd')),
          bankReference: text(get(d, 'Refs', 'AcctSvcrRef')) ?? text(get(n, 'AcctSvcrRef')),
        });
      }
    }
    return {
      iban: text(get(s, 'Acct', 'Id', 'IBAN')),
      openingCents: bal('OPBD') ?? bal('PRCD'),
      closingCents: bal('CLBD'),
      from: text(get(s, 'FrToDt', 'FrDtTm'))?.slice(0, 10) ?? null,
      to: text(get(s, 'FrToDt', 'ToDtTm'))?.slice(0, 10) ?? null,
      transactions,
    };
  });
}

/** Plain-German text for SEPA return reason codes (subset that clubs meet). */
export const RETURN_REASONS: Record<string, string> = {
  AC01: 'IBAN fehlerhaft',
  AC04: 'Konto erloschen',
  AC06: 'Konto gesperrt',
  AG01: 'Lastschrift auf diesem Konto nicht erlaubt',
  AM04: 'Konto nicht gedeckt',
  MD01: 'Kein gültiges Mandat',
  MD06: 'Widerspruch durch Zahler (Erstattung verlangt)',
  MD07: 'Kontoinhaber verstorben',
  MS02: 'Widerspruch durch Zahler',
  MS03: 'Grund nicht angegeben',
  SL01: 'Spezifische Dienstleistung der Bank',
};
