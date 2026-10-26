import { XMLParser } from 'fast-xml-parser';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, PDFHexString } from 'pdf-lib';

/** What an incoming e-invoice says, as a suggestion for the receipt form (the file itself is stored unchanged). */
export interface EinvoiceSuggestion {
  format: 'cii' | 'ubl';
  supplier: string | null;
  number: string | null;
  receiptDate: string | null;
  dueDate: string | null;
  totalCents: number | null;
  /** gross per VAT rate */
  groups: { ratePct: number; grossCents: number }[];
  /** Why amounts are not suggested (credit note, foreign currency): the receipt must be entered by hand. */
  unsupported: string | null;
}

/** UN/CEFACT 1001 document types that are credit notes, not invoices. */
const CREDIT_NOTE_TYPES = new Set(['81', '83', '261', '262', '296', '308', '381', '396', '420', '458', '532']);
const currencyOf = (v: unknown) => (v && typeof v === 'object' ? text((v as Node)['@currencyID']) : null);

/** Credit notes would be booked as expenses, foreign amounts as euros: no money is suggested from them. */
function guard(x: Omit<EinvoiceSuggestion, 'unsupported'>, creditNote: boolean, currencies: (string | null)[]): EinvoiceSuggestion {
  const foreign = currencies.find((c) => c && c.toUpperCase() !== 'EUR');
  const unsupported = creditNote ? 'Das ist eine Gutschrift. Gutschriften von Lieferanten lassen sich hier noch nicht übernehmen; erfasse sie von Hand.' : foreign ? `Die Rechnung lautet auf ${foreign}. Hier gehen nur Beträge in Euro; erfasse den Euro-Betrag von Hand.` : null;
  return unsupported ? { ...x, totalCents: null, groups: [], unsupported } : { ...x, unsupported: null };
}

type Node = Record<string, unknown>;
const cents = (v: unknown) => {
  const n = Number(typeof v === 'object' && v !== null ? (v as Node)['#text'] : v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const text = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === 'object' ? text((v as Node)['#text']) : String(v).trim() || null);
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const at = (n: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Node)[k] : undefined), n);
/** CII dates are YYYYMMDD (format 102); UBL dates are ISO. */
const isoDate = (v: unknown) => {
  const s = text(v);
  if (!s) return null;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** Parses XRechnung / ZUGFeRD XML (CII or UBL). Returns null for anything else. DOCTYPE and entities are refused. */
export function parseEinvoiceXml(xml: string): EinvoiceSuggestion | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, processEntities: false, parseTagValue: false, trimValues: true }).parse(xml) as Node;
  const cii = doc.CrossIndustryInvoice as Node | undefined;
  if (cii) {
    const tx = at(cii, 'SupplyChainTradeTransaction');
    const settle = at(tx, 'ApplicableHeaderTradeSettlement');
    const groups = arr(at(settle, 'ApplicableTradeTax') as Node | Node[]).map((t) => ({ ratePct: Number(text(at(t, 'RateApplicablePercent')) ?? 0), grossCents: (cents(at(t, 'BasisAmount')) ?? 0) + (cents(at(t, 'CalculatedAmount')) ?? 0) }));
    const sum = at(settle, 'SpecifiedTradeSettlementHeaderMonetarySummation');
    const type = text(at(cii, 'ExchangedDocument', 'TypeCode'));
    return guard({
      format: 'cii',
      supplier: text(at(tx, 'ApplicableHeaderTradeAgreement', 'SellerTradeParty', 'Name')),
      number: text(at(cii, 'ExchangedDocument', 'ID')),
      receiptDate: isoDate(at(cii, 'ExchangedDocument', 'IssueDateTime', 'DateTimeString')),
      dueDate: isoDate(at(arr(at(settle, 'SpecifiedTradePaymentTerms') as Node | Node[])[0], 'DueDateDateTime', 'DateTimeString')),
      totalCents: cents(at(sum, 'GrandTotalAmount')),
      groups,
    }, CREDIT_NOTE_TYPES.has(type ?? ''), [text(at(settle, 'InvoiceCurrencyCode')), currencyOf(at(sum, 'GrandTotalAmount')), currencyOf(at(sum, 'TaxBasisTotalAmount'))]);
  }
  const ubl = (doc.Invoice ?? doc.CreditNote) as Node | undefined;
  if (ubl) {
    const party = at(ubl, 'AccountingSupplierParty', 'Party');
    const groups = arr(at(ubl, 'TaxTotal', 'TaxSubtotal') as Node | Node[]).map((t) => ({ ratePct: Number(text(at(t, 'TaxCategory', 'Percent')) ?? 0), grossCents: (cents(at(t, 'TaxableAmount')) ?? 0) + (cents(at(t, 'TaxAmount')) ?? 0) }));
    const type = text(at(ubl, 'InvoiceTypeCode')) ?? text(at(ubl, 'CreditNoteTypeCode'));
    return guard({
      format: 'ubl',
      supplier: text(at(party, 'PartyLegalEntity', 'RegistrationName')) ?? text(at(party, 'PartyName', 'Name')),
      number: text(at(ubl, 'ID')),
      receiptDate: isoDate(at(ubl, 'IssueDate')),
      dueDate: isoDate(at(ubl, 'DueDate')),
      totalCents: cents(at(ubl, 'LegalMonetaryTotal', 'TaxInclusiveAmount')),
      groups,
    }, !!doc.CreditNote || CREDIT_NOTE_TYPES.has(type ?? ''), [text(at(ubl, 'DocumentCurrencyCode')), currencyOf(at(ubl, 'LegalMonetaryTotal', 'TaxInclusiveAmount'))]);
  }
  return null;
}

/** The XML embedded in a ZUGFeRD / Factur-X PDF (EmbeddedFiles name tree), or null. */
export async function embeddedXml(pdf: Buffer): Promise<string | null> {
  try {
    return await findXml(pdf);
  } catch {
    // Broken or unusual PDFs simply carry no readable e-invoice.
    return null;
  }
}

async function findXml(pdf: Buffer): Promise<string | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  const names = doc.catalog?.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const found: { name: string; spec: PDFDict }[] = [];
  const walk = (node: PDFDict | undefined, depth = 0) => {
    if (!node || depth > 8) return;
    const list = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let i = 0; list && i + 1 < list.size(); i += 2) {
      const n = list.lookup(i);
      const spec = list.lookup(i + 1);
      if ((n instanceof PDFString || n instanceof PDFHexString) && spec instanceof PDFDict) found.push({ name: n.decodeText(), spec });
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) walk(kids.lookup(i, PDFDict), depth + 1);
  };
  walk(names);
  const pick = found.find((f) => /\.xml$/i.test(f.name) && /factur-x|zugferd|xrechnung/i.test(f.name)) ?? found.find((f) => /\.xml$/i.test(f.name));
  const stream = pick?.spec.lookupMaybe(PDFName.of('EF'), PDFDict)?.lookup(PDFName.of('F'));
  if (!(stream instanceof PDFRawStream)) return null;
  return Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8');
}

/** Reads an uploaded receipt file: plain e-invoice XML or a PDF carrying one. */
export async function readEinvoice(bytes: Buffer): Promise<EinvoiceSuggestion | null> {
  if (bytes.length > 20 * 1024 * 1024) return null;
  const head = bytes.subarray(0, 5).toString();
  if (head === '%PDF-') {
    const xml = await embeddedXml(bytes);
    return xml ? parseEinvoiceXml(xml) : null;
  }
  const t = bytes.toString('utf8');
  return /^\s*(<\?xml|<)/.test(t) ? parseEinvoiceXml(t) : null;
}
