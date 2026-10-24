/**
 * SEPA files: pain.008.001.08 (direct debit) and pain.001.001.09 (credit transfer).
 * Pure string building; every generated file is validated against the official ISO 20022 XSD
 * (validate.ts) before anyone can download it.
 */

export interface DebitItem {
  endToEndId: string;
  amountCents: number;
  mandateId: string;
  mandateSignedOn: string;
  debtorName: string;
  debtorIban: string;
  debtorBic: string | null;
  remittance: string;
}

export interface CreditItem {
  endToEndId: string;
  amountCents: number;
  creditorName: string;
  creditorIban: string;
  creditorBic: string | null;
  remittance: string;
}

export interface Party {
  name: string;
  iban: string;
  bic: string | null;
}

/** SEPA's restricted Latin character set; German letters are transliterated, the rest dropped. */
export function sepaText(input: string, max: number) {
  const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', '&': '+', '–': '-', '—': '-', ı: 'i' };
  const t = input
    .replace(/[äöüÄÖÜß&–—ı]/g, (c) => map[c]!)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, max);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const amount = (c: number) => (c / 100).toFixed(2);
const agent = (bic: string | null) => (bic ? `<FinInstnId><BICFI>${esc(bic)}</BICFI></FinInstnId>` : '<FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId>');

export function pain008(o: {
  messageId: string;
  createdAt: string;
  creditor: Party;
  creditorId: string;
  collectionDate: string;
  sequenceType: 'FRST' | 'RCUR' | 'OOFF' | 'FNAL';
  batchBooking: boolean;
  items: DebitItem[];
}) {
  const sum = o.items.reduce((s, i) => s + i.amountCents, 0);
  const tx = o.items
    .map(
      (i) => `<DrctDbtTxInf>
<PmtId><EndToEndId>${esc(i.endToEndId)}</EndToEndId></PmtId>
<InstdAmt Ccy="EUR">${amount(i.amountCents)}</InstdAmt>
<DrctDbtTx><MndtRltdInf><MndtId>${esc(i.mandateId)}</MndtId><DtOfSgntr>${i.mandateSignedOn}</DtOfSgntr></MndtRltdInf></DrctDbtTx>
<DbtrAgt>${agent(i.debtorBic)}</DbtrAgt>
<Dbtr><Nm>${esc(sepaText(i.debtorName, 70) || 'Kontoinhaber')}</Nm></Dbtr>
<DbtrAcct><Id><IBAN>${i.debtorIban}</IBAN></Id></DbtrAcct>
<RmtInf><Ustrd>${esc(sepaText(i.remittance, 140))}</Ustrd></RmtInf>
</DrctDbtTxInf>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.08">
<CstmrDrctDbtInitn>
<GrpHdr><MsgId>${esc(o.messageId)}</MsgId><CreDtTm>${o.createdAt}</CreDtTm><NbOfTxs>${o.items.length}</NbOfTxs><CtrlSum>${amount(sum)}</CtrlSum><InitgPty><Nm>${esc(sepaText(o.creditor.name, 70))}</Nm></InitgPty></GrpHdr>
<PmtInf>
<PmtInfId>${esc(o.messageId)}</PmtInfId><PmtMtd>DD</PmtMtd><BtchBookg>${o.batchBooking}</BtchBookg><NbOfTxs>${o.items.length}</NbOfTxs><CtrlSum>${amount(sum)}</CtrlSum>
<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>${o.sequenceType}</SeqTp></PmtTpInf>
<ReqdColltnDt>${o.collectionDate}</ReqdColltnDt>
<Cdtr><Nm>${esc(sepaText(o.creditor.name, 70))}</Nm></Cdtr>
<CdtrAcct><Id><IBAN>${o.creditor.iban}</IBAN></Id></CdtrAcct>
<CdtrAgt>${agent(o.creditor.bic)}</CdtrAgt>
<ChrgBr>SLEV</ChrgBr>
<CdtrSchmeId><Id><PrvtId><Othr><Id>${esc(o.creditorId)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>
${tx}
</PmtInf>
</CstmrDrctDbtInitn>
</Document>
`;
}

export function pain001(o: { messageId: string; createdAt: string; debtor: Party; executionDate: string; batchBooking: boolean; items: CreditItem[] }) {
  const sum = o.items.reduce((s, i) => s + i.amountCents, 0);
  const tx = o.items
    .map(
      (i) => `<CdtTrfTxInf>
<PmtId><EndToEndId>${esc(i.endToEndId)}</EndToEndId></PmtId>
<Amt><InstdAmt Ccy="EUR">${amount(i.amountCents)}</InstdAmt></Amt>
${i.creditorBic ? `<CdtrAgt><FinInstnId><BICFI>${esc(i.creditorBic)}</BICFI></FinInstnId></CdtrAgt>` : ''}
<Cdtr><Nm>${esc(sepaText(i.creditorName, 70) || 'Kontoinhaber')}</Nm></Cdtr>
<CdtrAcct><Id><IBAN>${i.creditorIban}</IBAN></Id></CdtrAcct>
<RmtInf><Ustrd>${esc(sepaText(i.remittance, 140))}</Ustrd></RmtInf>
</CdtTrfTxInf>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
<CstmrCdtTrfInitn>
<GrpHdr><MsgId>${esc(o.messageId)}</MsgId><CreDtTm>${o.createdAt}</CreDtTm><NbOfTxs>${o.items.length}</NbOfTxs><CtrlSum>${amount(sum)}</CtrlSum><InitgPty><Nm>${esc(sepaText(o.debtor.name, 70))}</Nm></InitgPty></GrpHdr>
<PmtInf>
<PmtInfId>${esc(o.messageId)}</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>${o.batchBooking}</BtchBookg><NbOfTxs>${o.items.length}</NbOfTxs><CtrlSum>${amount(sum)}</CtrlSum>
<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
<ReqdExctnDt><Dt>${o.executionDate}</Dt></ReqdExctnDt>
<Dbtr><Nm>${esc(sepaText(o.debtor.name, 70))}</Nm></Dbtr>
<DbtrAcct><Id><IBAN>${o.debtor.iban}</IBAN></Id></DbtrAcct>
<DbtrAgt>${agent(o.debtor.bic)}</DbtrAgt>
<ChrgBr>SLEV</ChrgBr>
${tx}
</PmtInf>
</CstmrCdtTrfInitn>
</Document>
`;
}

/**
 * Splits items into files: at most 999 transactions and, when the bank sets one, at most the order
 * limit (Auftragslimit) in control sum per file. An item above the limit cannot be collected at all.
 */
export function splitIntoFiles<T extends { amountCents: number }>(items: T[], orderLimitCents: number | null, maxItems = 999): T[][] {
  const files: T[][] = [];
  let current: T[] = [];
  let sum = 0;
  for (const it of items) {
    if (orderLimitCents !== null && it.amountCents > orderLimitCents) throw new Error(`item of ${it.amountCents} cents exceeds the order limit`);
    if (current.length === maxItems || (orderLimitCents !== null && sum + it.amountCents > orderLimitCents)) {
      files.push(current);
      current = [];
      sum = 0;
    }
    current.push(it);
    sum += it.amountCents;
  }
  if (current.length) files.push(current);
  return files;
}

/** TARGET2 closing days: weekends, 1 Jan, Good Friday, Easter Monday, 1 May, 25 and 26 Dec. */
export function isTargetDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const md = date.slice(5);
  if (['01-01', '05-01', '12-25', '12-26'].includes(md)) return false;
  const easter = easterSunday(d.getUTCFullYear());
  const diff = Math.round((d.getTime() - easter.getTime()) / 86_400_000);
  return diff !== -2 && diff !== 1;
}

function easterSunday(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

/** Adds n TARGET2 business days to a date. */
export function addBusinessDays(date: string, n: number) {
  let d = date;
  let left = n;
  while (left > 0) {
    const next = new Date(`${d}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
    if (isTargetDay(d)) left--;
  }
  return d;
}
