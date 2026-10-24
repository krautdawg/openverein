## 1. Data and core

- [x] 1.1 Migration: creditor ID, bank accounts, mandates (encrypted IBAN, blind index), collection runs/files/items with the double-debit guard, statement imports, transactions, return debits
- [x] 1.2 pain.008.001.08 / pain.001.001.09 serializer, SEPA charset, splitting, TARGET2 calendar, XSD validation
- [x] 1.3 CAMT.053 parser (hardened) and German bank CSV parser
- [x] 1.4 Field encryption and blind index

## 2. API

- [x] 2.1 Mandates: list, create (replaces active), revoke, activate; hourly expiry after 36 months
- [x] 2.2 Bank accounts with balance
- [x] 2.3 Collection runs: candidates, create+generate, download, submitted, release
- [x] 2.4 Statement import, rollback, transactions, auto-match, allocate, ignore, unmatch, manual return
- [x] 2.5 Pre-notification frozen into invoices

## 3. Web

- [x] 3.1 Bank: accounts and import, reconciliation inbox, direct debits, run detail
- [x] 3.2 Member sheet mandate section; creditor ID in settings

## 4. Verification

- [x] 4.1 Unit: serializer against XSD, charset, splitting, creditor ID, TARGET2, CAMT fixtures incl. XXE, CSV, number regex
- [x] 4.2 Integration: mandates, double-debit guard, release confirmation, validation of dates, settlement, return debit, duplicates and overlaps, invoice-number matching, suggestions, allocate/ignore/undo, permissions
- [x] 4.3 Playwright: mandate, run, CAMT upload settles the invoice
