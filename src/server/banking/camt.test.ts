import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCamt053 } from './camt.ts';

const fixture = readFileSync(new URL('../../../tests/fixtures/camt053-v08.xml', import.meta.url), 'utf8');

describe('CAMT.053', () => {
  it('parses balances, splits batch bookings, signs debits, skips pending entries', () => {
    const [s] = parseCamt053(fixture);
    expect(s).toMatchObject({ iban: 'DE89370400440532013000', openingCents: 100000, closingCents: 114700, from: '2026-11-02', to: '2026-11-03' });
    expect(s!.transactions.map((t) => t.amountCents)).toEqual([12000, 12000, 3000, -12300]);
    expect(s!.transactions[0]).toMatchObject({ endToEndId: 'OV-1-0001', mandateId: 'M-0001', counterpartyName: 'Anna Becker', remittance: 'Beitrag R-2026-00001' });
    expect(s!.transactions[2]).toMatchObject({ endToEndId: null, remittance: 'R-2026-00005 Clara Hoffmann' });
    expect(s!.transactions[3]).toMatchObject({ returnReason: 'AM04', counterpartyName: 'Ben Schulz' });
  });

  it('refuses DOCTYPE and entity declarations (XXE)', () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Document><BkToCstmrStmt><Stmt/></BkToCstmrStmt></Document>`;
    expect(() => parseCamt053(evil)).toThrow(/DOCTYPE/);
  });

  it('parses the older .001.02 layout (party name without Pty)', () => {
    const v2 = fixture.replace('camt.053.001.08', 'camt.053.001.02').replaceAll('<Pty><Nm>Anna Becker</Nm></Pty>', '<Nm>Anna Becker</Nm>');
    expect(parseCamt053(v2)[0]!.transactions[0]!.counterpartyName).toBe('Anna Becker');
  });

  it('keeps no single identity for an aggregate it cannot split, and imports only explicitly booked entries', () => {
    const doc = (entries: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>${entries}</Stmt></BkToCstmrStmt></Document>`;
    const detail = (e2e: string, amt: string) => `<TxDtls><Refs><EndToEndId>${e2e}</EndToEndId></Refs><AmtDtls><TxAmt><Amt Ccy="EUR">${amt}</Amt></TxAmt></AmtDtls><RtrInf><Rsn><Cd>AM04</Cd></Rsn></RtrInf></TxDtls>`;
    const entry = (sts: string, body: string, amt = '203.00') => `<Ntry><Amt Ccy="EUR">${amt}</Amt><CdtDbtInd>DBIT</CdtDbtInd>${sts}<BookgDt><Dt>2026-11-03</Dt></BookgDt><NtryDtls>${body}</NtryDtls></Ntry>`;
    // Two returns of 100 € plus a 3 € fee in one aggregate: no detail's end-to-end ID on the 203 € movement.
    const [agg] = parseCamt053(doc(entry('<Sts><Cd>BOOK</Cd></Sts>', detail('OV-1', '100.00') + detail('OV-2', '100.00'))));
    expect(agg!.transactions).toEqual([expect.objectContaining({ amountCents: -20300, endToEndId: null, returnReason: null })]);
    // Pending (proprietary) and missing statuses are not booked.
    const [pend] = parseCamt053(doc(entry('<Sts><Prtry>PDNG</Prtry></Sts>', detail('OV-3', '203.00')) + entry('', detail('OV-4', '203.00'))));
    expect(pend!.transactions).toEqual([]);
  });
});
