## Why

Most clubs hand their books to a tax adviser who works in DATEV, and a tax audit asks for the GoBD data-access package. Slice 12 adds both exports on top of the journal.

## What Changes

- DATEV settings: consultant number, client number, account length, start month of the fiscal year.
- DATEV EXTF 700 Buchungsstapel (category 21) as a ZIP: delta (entries not exported yet) or full for a period; refused with a list while used accounts lack a DATEV number; sphere as KOST1, cost centre as KOST2; Windows-1252 with CRLF. Exports are stored with SHA-256 and the entries they contained (the journal stays untouched); after an export the UI offers to lock the period.
- GoBD Z3 package per fiscal year: `index.xml` in the Beschreibungsstandard and CSV tables for entries, lines, accounts, invoices and debtors; every download is audit-logged.
- Own ZIP writer and Windows-1252 encoder (no dependencies).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bookkeeping`: explicit tax lines instead of BU keys; no debtor/creditor master data (cash basis with collective accounts).

## Impact

Migration `0014_datev.sql`. Deferred (docs/decisions.md): debtor/creditor master data (category 16), receipt images with `document.xml` (receipts slice), a verified import test with DATEV.
