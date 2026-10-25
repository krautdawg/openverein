# sepa Specification

## Purpose
The sepa capability covers SEPA mandates, direct-debit collection runs (pain.008.001.08) with pre-notification and the double-debit guard, credit-transfer files (pain.001.001.09), bank statement import from CAMT.053 and CSV, payment matching with the reconciliation inbox, and return-debit handling (B M14, M15, M16, M17, M18, M19). All amounts are integer cents. Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.
## Requirements
### Requirement: Mandate records
The system SHALL store each SEPA mandate as its own record with reference (at most 35 characters from the SEPA character set, unique per creditor ID, generated from a pattern such as `{member_no}-{seq}` or entered, imported references kept unchanged), signature date, debtor person, account holder name, IBAN checked by mod-97, optional BIC derived from the Bundesbank BLZ file for German IBANs, scheme (CORE or B2B), type (recurrent or one-off) and evidence file, and SHALL render a pre-filled mandate form as PDF.

#### Scenario: Invalid IBAN
- **WHEN** an IBAN with a wrong check digit is entered
- **THEN** the mandate is rejected

#### Scenario: Invalid reference character
- **WHEN** a reference contains `ä` or `_`
- **THEN** the mandate is rejected naming the allowed character set

### Requirement: Mandate lifecycle
The system SHALL use the states `pending_evidence`, `active`, `amended`, `revoked` and `expired`, collect only `active` mandates, record amendments (IBAN, holder name, reference) with date in a history so that the next collection carries the amendment information pain.008 requires, record revocations with date and source (member, bank, admin), warn 60 days ahead and move to `expired` any mandate unused for 36 months.

#### Scenario: Pending mandate not collected
- **WHEN** a collection run is prepared for a member whose mandate is `pending_evidence`
- **THEN** the readiness column shows "not active" and the invoice is not included

#### Scenario: Amendment carried
- **WHEN** a mandate's IBAN was amended after the last collection
- **THEN** the next pain.008 item carries the amendment information

#### Scenario: Expiry
- **WHEN** a mandate has not been used for 36 months
- **THEN** the nightly job moves it to `expired`

### Requirement: IBAN protection
The system SHALL encrypt IBANs at rest, keep a keyed hash for matching, and show IBANs in full only to users with the IBAN field permission; everyone else SHALL see a masked form such as `DE•• •••• •••• •••• ••12 34`.

#### Scenario: Masked IBAN
- **WHEN** a user without the IBAN right opens a mandate
- **THEN** only the masked IBAN with the last four digits is shown

### Requirement: Collection run preparation
The system SHALL create a direct-debit run from selected open receivables (all with an active mandate, a saved view, or hand-picked) with a readiness column (mandate OK, missing, not active, transfer payer) and settings for creditor account, validated creditor ID, requested collection date, batch booking and one item per invoice or per debtor; the collection date SHALL be checked against TARGET2 business days and the bank account's minimum lead time (default 2 business days, never below D-1 for CORE), and the proposed date SHALL be today plus 5 business days.

#### Scenario: Date too early
- **WHEN** a collection date one business day ahead is chosen with a 2-day lead time
- **THEN** the run cannot be generated until a valid date is chosen

#### Scenario: Holiday skipped
- **WHEN** the proposed date would fall on a TARGET2 holiday
- **THEN** the next TARGET2 business day is proposed

### Requirement: File splitting by order limit
The system SHALL split collection files so that no payment information block holds more than 999 transactions and, where the bank account has an order limit (Auftragslimit), no file's control sum exceeds it.

#### Scenario: Order limit
- **WHEN** a run totals 3000000 cents and the order limit is 2000000 cents
- **THEN** at least two files are generated, each at or below 2000000 cents

### Requirement: Direct-debit remittance template (should)
The system SHALL build each debit's remittance text from a template with placeholders for invoice number, member number and period, limited to 140 characters of the SEPA character set.

#### Scenario: Remittance rendered
- **WHEN** the template is `Beitrag {period} Mitgl. {member_no} Re {invoice_no}`
- **THEN** each debit carries the rendered text, at most 140 characters

### Requirement: Pre-notification
The system SHALL send each debtor a pre-notification by e-mail or letter with amount, collection date, mandate reference and creditor ID at least the configured number of days before the collection date (default 14, minimum 1 if agreed in the mandate), and log each notification per debtor and run.

#### Scenario: Late pre-notification
- **WHEN** pre-notifications have not been sent 14 days before the collection date
- **THEN** the run warns and proposes a later collection date

### Requirement: pain.008 generation and stored bytes
The system SHALL generate pain.008.001.08 files with sequence type RCUR (OOFF for one-off mandates, FRST optional by setting), validate them against the official XSD before offering them, and store the exact bytes, SHA-256, message ID and schema version on the run so that every re-download returns the same bytes.

#### Scenario: XSD failure
- **WHEN** a generated file fails XSD validation
- **THEN** it is not offered for download and the error is shown

#### Scenario: Re-download
- **WHEN** a generated file is downloaded again
- **THEN** its SHA-256 equals the stored hash

### Requirement: Double-debit guard
The system SHALL allow each invoice to be live in at most one collection item at a time, enforced by a database constraint, also when one item per debtor carries several invoices; an invoice stays live from inclusion until its item is returned or its run is released, and selecting it for another run SHALL be blocked meanwhile.

#### Scenario: Second run blocked
- **WHEN** an invoice in a `downloaded` run is selected for a new run
- **THEN** the system refuses to include it

#### Scenario: Per-debtor item
- **WHEN** a per-debtor item carries invoices A and B and a second run tries to include B
- **THEN** B is refused

### Requirement: Collection run states and release
The system SHALL move runs through `draft` → `generated` → `downloaded` (set on the first file download) → `submitted` (marked by the treasurer) → `settled` or `partly_returned`, plus `released`; a `generated` run never downloaded MAY be cancelled and releases its invoices; a `downloaded` run SHALL be released only when the treasurer confirms with TOTP that the file was never uploaded, or when imported statements after the collection date show it was not executed.

#### Scenario: Downloaded run release
- **WHEN** a treasurer releases a `downloaded` run
- **THEN** the system requires TOTP and the statement that the file was never submitted before releasing the invoices

#### Scenario: Automatic downloaded state
- **WHEN** the file of a `generated` run is downloaded for the first time
- **THEN** the run moves to `downloaded`

### Requirement: Credit transfer files
The system SHALL generate pain.001.001.09 files from selected open payables (receipts, credit notes, refunds of overpayments), XSD-validated and stored with bytes, hash, execution date and debtor account, carry the receipt or credit-note number in each remittance, and block payables in a generated transfer run from a second run.

#### Scenario: Payable paid twice
- **WHEN** a receipt already in a generated transfer run is selected again
- **THEN** the system refuses

### Requirement: Bank statement import
The system SHALL import CAMT.053 (.001.02 and .001.08, batch bookings split into items) and CSV files through saved bank profiles (column mapping, date format, decimal separator, encoding; presets for Sparkasse, Volksbank, Deutsche Bank, Commerzbank, GLS, ING, DKB); it SHALL store the raw file encrypted with SHA-256, reject the same file twice, de-duplicate overlapping periods by a transaction fingerprint with a review for near-duplicates, block completion when opening and closing balances do not match the running balance (override with reason), reject XML with DOCTYPE, and allow rolling back an import while none of its transactions is posted.

#### Scenario: Same file twice
- **WHEN** a CAMT file with a known SHA-256 is imported again for the same account
- **THEN** the import is rejected

#### Scenario: Overlapping statements
- **WHEN** two statements cover 1–15 and 10–31 March
- **THEN** transactions from 10–15 March are imported once

#### Scenario: Balance mismatch
- **WHEN** the statement's opening balance differs from the account's running balance
- **THEN** completion is blocked unless overridden with a reason

### Requirement: Payment matching and reconciliation inbox
The system SHALL match transactions by rules in fixed order (end-to-end ID of a collection item; invoice number in remittance text; mandate reference; member number; amount plus counterparty IBAN against open items; learned counterparty rules), show each suggestion with score 0–100, the rule and the matched text highlighted, auto-confirm only rules 1–2 above a configurable threshold (default 95), and keep everything else in an inbox with counters (unmatched, suggested, needs receipt) and a keyboard flow; allocations SHALL be many-to-many with the remainder becoming credit or staying open; non-invoice bookings SHALL be allocated directly to account, sphere and cost centre; confirming an allocation SHALL post the journal entry and undoing it SHALL post a reversal.

#### Scenario: Auto-confirm by end-to-end ID
- **WHEN** a credit carries the end-to-end ID of a collection item and scores 98
- **THEN** the allocation is confirmed and posted automatically

#### Scenario: Amount match waits
- **WHEN** a transfer matches an open item only by amount and IBAN
- **THEN** it waits in the inbox as a suggestion

#### Scenario: Collective transfer
- **WHEN** one transfer of 9000 cents pays three invoices of 3000 cents
- **THEN** it is allocated to all three and each is `paid`

### Requirement: Bulk allocation (should)
The system SHALL allocate several selected unposted transactions to one ledger account, sphere and cost centre in one step; posted entries SHALL change only through reversals.

#### Scenario: Bank fees in bulk
- **WHEN** a treasurer selects twelve unposted bank-fee transactions and allocates them to one account
- **THEN** twelve entries are posted to that account

### Requirement: Return debits
The system SHALL detect returns from CAMT reason codes (for example AC04, AM04, MD06, MS02) and the original end-to-end ID, or for CSV from keywords ("Rücklastschrift", "Retoure", "Rückgabe") plus amount and IBAN; processing SHALL in one transaction link the return to the collection item, reverse the allocation and reopen the invoice, book the bank fee as expense, add an optional recharge fee as a new line or invoice, store the reason code shown in plain German, propose revoking or reviewing the mandate for MD06 / MD01, and optionally trigger a dunning step and member notification; several returns from one statement SHALL be processable in bulk, with an optional automatic mode for high-confidence returns.

#### Scenario: Account closed
- **WHEN** a return with code AC04 and a 300-cent bank fee is processed
- **THEN** the invoice reopens, 300 cents are booked as expense and the reason shows "Konto erloschen"

#### Scenario: Refund requested
- **WHEN** a return carries MD06
- **THEN** the system proposes reviewing or revoking the mandate

### Requirement: Pre-notification on the invoice
The system SHALL print the SEPA pre-notification on every invoice of a member paying by direct debit with an active mandate (amount, earliest collection date equal to the due date, mandate reference, creditor ID), freeze these values at issue, and SHALL refuse to put an invoice into a collection run whose collection date is before the invoice's due date.

#### Scenario: Collection before due date
- **WHEN** a treasurer creates a run on 2 November for an invoice due on 15 November
- **THEN** the run is refused with a message about the pre-notification

### Requirement: Automatic matching order
The system SHALL match imported transactions automatically only in these cases, in this order: end-to-end ID of an open collection item with the same amount (settle), end-to-end ID of a collected item on a debit (return debit), a credit equal to the control sum of a downloaded or submitted file within ten days of its collection date while all its items are open (settle the file), and exactly one invoice number in the remittance text with the exact open amount (allocate); everything else SHALL only be suggested.

#### Scenario: Partial payment is only suggested
- **WHEN** a transfer of 2000 cents mentions an invoice with 5000 cents open
- **THEN** the transaction stays in the inbox with that invoice as a suggestion and nothing is booked

### Requirement: Mandate amendment after an IBAN change
The system SHALL keep the mandate when an accepted IBAN change replaces the debtor account and mark the next direct debit with the amendment indicator: with the original account when the bank stays the same, otherwise with original debtor agent `SMNDA`.

#### Scenario: New bank
- **WHEN** a member's accepted IBAN change moves the account to another bank and the next debit run is generated
- **THEN** that member's transaction carries `AmdmntInd` true and `OrgnlDbtrAgt` `SMNDA`, and later runs do not

### Requirement: Remittance text template
The system SHALL build each debit's remittance text from the organisation's template and refuse templates with unknown placeholders.

#### Scenario: Member number in the remittance text
- **WHEN** the template is "Beitrag {{mitgliedsnummer}} {{rechnungsnummer}}" and a debit run is generated
- **THEN** each debit's Ustrd reads "Beitrag <member number> <invoice number>"

