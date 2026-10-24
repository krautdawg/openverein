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
});
