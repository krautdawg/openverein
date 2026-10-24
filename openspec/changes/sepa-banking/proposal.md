## Why

Most clubs collect fees by SEPA direct debit and spend hours matching bank statements to invoices. Slice 3 closes the money loop: mandates, a bank-ready collection file that can never debit an invoice twice, statement import and automatic matching, including return debits.

## What Changes

- SEPA mandates per member: reference (SEPA charset, unique), signature date, account holder, IBAN (mod-97, stored encrypted with a blind index), BIC, recurrent or one-off, states pending evidence / active / revoked / expired (36 months unused), one active mandate per person.
- Creditor ID on the organisation (check digits validated); bank accounts with opening balance, lead days and order limit.
- Collection runs: candidates with readiness (mandate, payment method, already in a run), TARGET2 business days and lead time, never before the invoice's due date (pre-notification printed on the invoice: amount, earliest date, mandate reference, creditor ID), pain.008.001.08 files split by 999 items and the order limit, each validated against the official ISO 20022 XSD, stored encrypted with SHA-256; download marks the run live; release needs a confirmation after download. Double-debit guard: partial unique index on live collection item invoices.
- pain.001.001.09 transfer runs for open credit notes.
- Bank statement import: CAMT.053 (.001.02–.001.08, DOCTYPE/ENTITY refused, 50 MB cap, batch bookings split) and German bank CSV exports; duplicate files refused, overlapping statements de-duplicated by fingerprint; closing balance check; rollback while nothing is matched.
- Matching: end-to-end ID → settle item; return with E2E → return debit (allocation reversed, invoice reopened, fee recorded, MD01/MD06 put the mandate on hold); batch credit equal to a file's control sum → settle the file; invoice number plus exact amount → allocate; suggestions by invoice number and known IBAN; manual allocate, ignore with note, undo.
- UI: Bank section (accounts and import, reconciliation inbox, direct debits and run detail), mandate section in the member sheet, creditor ID in settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sepa`: adds the concrete pre-notification-on-invoice rule and automatic matching order.

## Impact

Migration `0005_sepa_banking.sql`. Dependencies: `fast-xml-parser` (CAMT), `libxml2-wasm` (XSD validation). ISO 20022 XSDs vendored in `src/server/sepa/xsd/`. New env `DATA_KEY` for field encryption. Deferred (see `docs/decisions.md`): mandate amendments (an IBAN change creates a new mandate), FRST sequence type, pre-notification by e-mail, ledger postings of bank fees, MT940, online banking.
