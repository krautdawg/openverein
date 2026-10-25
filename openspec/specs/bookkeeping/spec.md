# bookkeeping Specification

## Purpose
The bookkeeping capability covers the cash-basis EÜR on a balanced append-only journal with SKR accounts, tax spheres, cost centres and tax rates, bank and cash accounts with cash book, receipts, the GoBD period lock with reversal corrections, EÜR and ledger reports with the tax-audit export, DATEV EXTF export, outgoing e-invoices, and donations with BMF donation receipts (B M20, M21, M22, M23, M24, M25, M26, M43). All amounts are integer cents. Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.
## Requirements
### Requirement: Chart of accounts
The system SHALL ship SKR 42 and SKR 49 as versioned templates, allow custom accounts, and allow used accounts only to be retired, not deleted, so that old reports stay reproducible.

#### Scenario: Used account
- **WHEN** an admin deletes an account with posted lines
- **THEN** the system refuses and offers to retire it

### Requirement: Hide accounts from pickers (should)
The system SHALL let accounts be hidden from pickers without retiring them.

#### Scenario: Hidden account
- **WHEN** an account is hidden
- **THEN** it no longer appears in booking pickers but stays in reports

### Requirement: Tax spheres
The system SHALL book every line to one of the four spheres (ideeller Bereich, Vermögensverwaltung, Zweckbetrieb, wirtschaftlicher Geschäftsbetrieb) or the SKR 42 collective code 9, warn when economic-sphere gross income reaches 80 % of EUR 50,000 in a year, and block code 9 for the year once it exceeds EUR 50,000.

#### Scenario: Limit exceeded
- **WHEN** economic-sphere gross income for 2027 reaches 5000001 cents
- **THEN** new bookings to code 9 for 2027 are blocked

#### Scenario: Early warning
- **WHEN** it reaches 4000000 cents
- **THEN** a warning is shown

### Requirement: Tax rates as records
The system SHALL keep tax rates as records (rate, valid from / to, output-VAT account, input-VAT account), seeded with German rates including the historic 5 % and 16 %, allow club-defined rates, and have lines reference a rate from which DATEV and e-invoices read the accounts.

#### Scenario: Historic rate
- **WHEN** a receipt dated in the second half of 2020 is entered at 16 %
- **THEN** the seeded 16 % rate valid on that date is used

### Requirement: Balanced append-only journal
The system SHALL post only balanced journal entries (sum of debits equals sum of credits), each with date, entry number, text, source (bank transaction, invoice, receipt, manual, reversal, import), posting user and receipt files; posted entries and lines SHALL be immutable at database level, and issuing an invoice SHALL NOT post to the journal (cash basis), while a confirmed payment allocation SHALL.

#### Scenario: Unbalanced entry
- **WHEN** an entry with 10000 cents debit and 9000 cents credit is committed
- **THEN** the transaction fails

#### Scenario: Update refused
- **WHEN** any role tries to update or delete a posted line
- **THEN** the database raises an error

### Requirement: EÜR booking form with multi-rate lines
The system SHALL let treasurers book "income / expense on account X, sphere Y, cost centre Z" and generate the double-entry lines, hiding debit and credit unless details are opened; one receipt or booking MAY carry lines at 0 %, 7 % and 19 %.

#### Scenario: Multi-rate receipt
- **WHEN** a receipt has lines at 7 % and 19 %
- **THEN** one entry is posted with separate tax lines for each rate

### Requirement: Bank and cash accounts with cash book
The system SHALL keep bank, cash and payment-provider accounts with IBAN, BIC, holder, opening balance and date, linked ledger account and default sphere, show running and any-date closing balances, keep a cash book per cash account with chronological numbered entries, daily balance and a receipt per entry, reject any cash entry that would make the balance negative, book transfers between own accounts as a transit pair rather than income, and export the cash book as PDF.

#### Scenario: Negative cash refused
- **WHEN** a cash expense of 5000 cents is entered while the cash box holds 3000 cents
- **THEN** the entry is rejected with an explanation

#### Scenario: Cash deposit
- **WHEN** 20000 cents are moved from the cash box to the bank
- **THEN** a transit pair is booked and the EÜR shows no income

### Requirement: Receipts
The system SHALL record supplier receipts with supplier, number, date, due date, lines (text, amount, tax rate, account, sphere, cost centre) and files uploaded by drag-and-drop or phone camera, with states `recorded` → `open` → `paid` → posted; ZUGFeRD and XRechnung files SHALL be stored unchanged with the PDF shown and lines entered by hand; the system SHALL warn on the same supplier and number or the same file hash.

#### Scenario: Duplicate receipt
- **WHEN** a receipt file with a known SHA-256 is uploaded
- **THEN** the system warns that it may be a duplicate

### Requirement: Self-issued receipts (should)
The system SHALL create an Eigenbeleg for expenses without a supplier document with reason, date, amount and signer, render it as PDF and store it like any receipt.

#### Scenario: Eigenbeleg
- **WHEN** a treasurer records a 1500-cent parking fee without a ticket
- **THEN** a self-issued receipt PDF is stored with the booking

### Requirement: GoBD period lock and close
The system SHALL refuse any posting, reversal or allocation dated on or before the organisation's lock date; moving the lock date backwards SHALL require the treasurer role with TOTP and a reason and be audit-logged; closing a fiscal period SHALL store a report snapshot (EÜR totals, account balances, hash); and the system SHALL generate a Verfahrensdokumentation draft from configuration.

#### Scenario: Posting into locked period
- **WHEN** the lock date is 31 December 2026 and a booking dated 15 December 2026 is posted
- **THEN** it is refused

#### Scenario: Unlock audited
- **WHEN** a treasurer moves the lock date back with TOTP and reason
- **THEN** the change is applied and audit-logged with the reason

### Requirement: Reversal corrections
The system SHALL correct posted entries only by a reversal entry (on the original date or today, by setting) plus a pre-filled new entry.

#### Scenario: Correct entry
- **WHEN** a user chooses "correct" on a posted entry
- **THEN** a reversal entry is posted and a new pre-filled entry opens; the original stays unchanged

### Requirement: EÜR and ledger reports
The system SHALL produce the EÜR for any date range per sphere and in total with net, gross and tax columns and drill-down, ledger sheets per account, a trial balance and a cost-centre report, as PDF and XLSX (large reports as jobs), with a warning panel above every report (unposted transactions, transactions without receipt, code 9 above the limit, open allocations, bank balance differences, accounts without DATEV mapping); a report for a closed period SHALL match its snapshot or show the difference.

#### Scenario: Warnings shown
- **WHEN** the EÜR range contains three transactions without receipts
- **THEN** the warning panel shows "3 transactions without receipt" with a link

#### Scenario: Snapshot difference
- **WHEN** a closed-period report differs from its stored snapshot
- **THEN** the report shows the difference

### Requirement: Tax-audit data access export
The system SHALL export per fiscal year the GoBD Z3 data-access package in the Beschreibungsstandard (`index.xml` plus one CSV per table: journal, lines, accounts, receipts, invoices, debtors / creditors) and audit-log every access.

#### Scenario: Z3 package
- **WHEN** a tax adviser exports 2026
- **THEN** a package with `index.xml` and the table CSVs is produced and the access is logged

### Requirement: Account summary report (should)
The system SHALL show per bank and cash account for a range the opening balance, income, expenses, surplus and closing balance.

#### Scenario: Cash auditor sheet
- **WHEN** a cash auditor runs the summary for 2026
- **THEN** each account shows opening balance, income, expenses, surplus and closing balance that add up

### Requirement: DATEV EXTF export
The system SHALL export booking batches (EXTF format version 700, category 21) and debtor / creditor master data (category 16) as a ZIP with receipt files referenced by document GUID and a `document.xml`, as delta (since the last export) or full export for a period, with header fields from settings (consultant number, client number, fiscal year start, account length, SKR) and sphere and cost centre mapped to KOST1 / KOST2; exported entries SHALL be marked with the export id, and the export SHALL refuse to run while accounts lack a DATEV mapping and list them.

#### Scenario: Missing mapping
- **WHEN** an account used in the period has no DATEV mapping
- **THEN** the export refuses and lists the account

#### Scenario: Delta export
- **WHEN** a delta export runs after a previous export
- **THEN** it contains only entries not yet exported

### Requirement: DATEV export options (should)
The system SHALL offer one collective debtor and one collective creditor number instead of per-person numbers, and after an export SHALL offer to move the lock date to the end of the exported period under the same TOTP rule.

#### Scenario: Lock offer
- **WHEN** a DATEV export for Q1 completes
- **THEN** the treasurer is offered to set the lock date to 31 March

### Requirement: Outgoing e-invoices
The system SHALL issue invoices in the economic sphere (and taxable Zweckbetrieb) to business recipients as ZUGFeRD (EN 16931, PDF/A-3 with embedded CII XML) or XRechnung (CII or UBL), chosen per recipient; issuing SHALL be blocked with a clear message while mandatory EN 16931 fields (seller VAT ID or tax number, buyer reference / Leitweg-ID for public buyers, tax category per line) are missing; files SHALL pass the KoSIT validator in CI and be stored once with SHA-256; a Kleinunternehmer setting (§19 UStG) SHALL turn the obligation off and label invoices accordingly.

#### Scenario: Missing Leitweg-ID
- **WHEN** an XRechnung to a public buyer has no Leitweg-ID
- **THEN** issuing is blocked naming the missing field

### Requirement: Donations
The system SHALL record money donations from allocated bank transactions, cash entries or manual entry with donor, date, amount in cents, purpose, sphere and membership-fee flag, and check eligibility before issuing a receipt: the exemption notice date is not older than 5 years (Freistellungsbescheid) or 3 years (Feststellungsbescheid), the purpose is covered and the donor address is present.

#### Scenario: Expired notice
- **WHEN** the organisation's Freistellungsbescheid is dated six years ago
- **THEN** issuing a donation receipt is blocked

### Requirement: Donation receipts
The system SHALL issue single receipts and annual collective receipts with annex list from versioned, non-editable BMF template packs (pack version stored on the receipt), number them gaplessly, render them once with stored bytes and hash, send them by preferred channel, and never edit them; a wrong receipt SHALL be cancelled with reason and date and reissued with a new number; a donation SHALL be on at most one non-cancelled receipt, imported receipts included; bulk collective receipts for a year SHALL be previewed first; receipts for donations up to EUR 300 SHALL carry the simplified-proof note; an optional signature image with the machine-generated statement SHALL be supported.

#### Scenario: Donation receipted twice
- **WHEN** a collective receipt would include a donation already on a non-cancelled receipt
- **THEN** that donation is excluded and listed as already receipted

#### Scenario: Cancel and reissue
- **WHEN** a receipt with a wrong address is cancelled
- **THEN** it keeps its number and PDF with status cancelled, and the reissue gets a new number

### Requirement: Neutral default chart with DATEV mapping
The system SHALL seed each club with a small neutral chart of accounts (money, transit, tax, income and expense accounts with a default sphere) and let every account carry the account number of the tax adviser's DATEV chart; the warning panel SHALL list used accounts without a DATEV number.

#### Scenario: Missing DATEV number
- **WHEN** an account with postings in the report range has no DATEV number
- **THEN** the EÜR warning panel shows how many accounts lack it and links to the chart

### Requirement: Payments post through an idempotent sync
The system SHALL post each confirmed payment allocation exactly once and each reversed allocation's posting exactly once as a reversal, before any journal read, report or lock change.

#### Scenario: Payment reversed
- **WHEN** a cash payment of 60 € is reversed
- **THEN** the journal shows the original posting and one reversal entry, and the original stays unchanged

### Requirement: DATEV rows with explicit tax lines
The system SHALL export each journal entry as DATEV rows of one account against one counter-account whose amounts add up to the entry, without BU keys, with tax lines as separate postings to the mapped tax accounts.

#### Scenario: Expense at 19 %
- **WHEN** an expense of 119 € with 19 % VAT is exported
- **THEN** the batch contains one row of 100 € to the expense account and one row of 19 € to the input-tax account, both against the bank account

### Requirement: Cancelled receipts free their donations
The system SHALL keep a cancelled donation receipt with its reason and stored PDF, and SHALL let its donations be put on a new receipt with a new number.

#### Scenario: Reissue after cancellation
- **WHEN** a receipt is cancelled with the reason "Name falsch geschrieben"
- **THEN** the receipt shows as cancelled and a new receipt for the same donation can be issued

### Requirement: Receipts post when paid
The system SHALL keep a recorded receipt out of the journal until it is paid and SHALL then post its lines on the payment date against the chosen money account; voiding a paid receipt SHALL post a reversal.

#### Scenario: Receipt paid later
- **WHEN** a receipt dated 1 April is paid by bank on 3 April
- **THEN** the journal shows the expense on 3 April and the receipt is frozen

### Requirement: E-invoice amount due equals the printed total
The system SHALL produce XRechnung files whose amount due equals the issued invoice's gross total, putting rounding differences between gross and net-plus-tax into the rounding amount.

#### Scenario: Rounding case
- **WHEN** a 19 % line of 10.01 € gross is issued as XRechnung
- **THEN** the file's amount due is 10.01 € and the KoSIT validator accepts it

### Requirement: E-invoices are mailed with their XML
The system SHALL attach the stored XRechnung XML to the invoice mail and send it to the recipient's e-invoice address when that is an e-mail address.

#### Scenario: City with an e-invoice mailbox
- **WHEN** an issued XRechnung invoice to a city with e-invoice address rechnung@stadt.example is mailed
- **THEN** one mail goes to rechnung@stadt.example with the PDF and the XML attached

### Requirement: In-kind donation receipts
The system SHALL record in-kind donations with value, description and origin and confirm each on the BMF template for Sachzuwendungen, never on a collective receipt.

#### Scenario: Annual run with goods
- **WHEN** a donor gave money and goods in a year and the annual receipts are issued
- **THEN** the donor gets one money receipt and a separate Sachzuwendung receipt

### Requirement: Volunteer allowance limits
The system SHALL track Übungsleiter- and Ehrenamtspauschale payments per person and year together with declared use elsewhere, and warn when a payment exceeds the tax-free limit of that year.

#### Scenario: Over the limit
- **WHEN** a trainer with 1,000 € declared elsewhere receives 2,500 € in 2026
- **THEN** the rest shows 200 € over the 3,300 € limit and the payment response warns about it

### Requirement: Incoming e-invoices fill the receipt form
The system SHALL read uploaded XRechnung, UBL, CII and ZUGFeRD files and suggest supplier, number, dates and gross amounts per VAT rate for the receipt, while storing the file unchanged.

#### Scenario: ZUGFeRD PDF
- **WHEN** a ZUGFeRD PDF with an invoice of 238,00 € at 19 % is uploaded
- **THEN** the receipt form shows the supplier, the invoice number and one line of 238,00 € with 19 %

