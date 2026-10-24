# fees-and-invoices Specification

## Purpose
The fees-and-invoices capability covers effective-dated fee plans and assignments, the fee run with mandatory preview and the double-billing guard, invoices with immutable issued documents, gapless numbering, cancellation documents and EPC QR codes, and open items with dunning and write-off (B M10, M11, M12, M13). All amounts are integer cents. Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.
## Requirements
### Requirement: Effective-dated fee plans
The system SHALL keep fee plans with name, invoice line text, ledger account, tax sphere, cost centre and tax rate, and versions with `valid_from`, amount in cents, interval (one-off or 1 to 60 whole months, optionally restricted by the organisation), due-day rule, proration policy (`none`, `month`, `day`, with an "exit month counts" flag), admission fee, period anchor (`calendar` or `entry`) and first-period rule (join date, 1st of join month, 1st of next month, start of quarter, start of half-year, or set by hand); changing an amount SHALL create a new version and never alter posted assessments, and a plan with assessments SHALL only be retired, not deleted.

#### Scenario: Amount change creates version
- **WHEN** the general assembly raises the adult fee from 12000 to 14400 cents from 1 January 2027
- **THEN** a new version valid from 2027-01-01 is created and 2026 assessments keep 12000 cents

#### Scenario: Every easyVerein interval allowed
- **WHEN** a plan version is created with an interval of 24 months
- **THEN** it is accepted, while 61 months is rejected

#### Scenario: Plan with assessments
- **WHEN** an admin deletes a plan that has assessments
- **THEN** the system refuses and offers to retire it

### Requirement: Fee assignments
The system SHALL assign plans to members as dated fee assignments with exactly one main plan and any number of add-on plans at any date, an optional individual amount override with a mandatory reason, an optional payer override and a first service period start; each member SHALL have a default payment method (none, direct debit, transfer, cash, custom) overridden by a household or payer setting; a person's credit balance SHALL be offset against new assessments unless the person opted out.

#### Scenario: Second main plan rejected
- **WHEN** a member with main plan "Erwachsene" from 1 January gets main plan "Familie" from 1 March without ending the first
- **THEN** the assignment is rejected

#### Scenario: Credit offset
- **WHEN** a member with 2000 cents credit is assessed 6000 cents
- **THEN** the invoice shows 6000 cents with a 2000-cent credit offset and 4000 cents due

### Requirement: Fee calculator
The system SHALL answer on the member profile what the member will pay for a chosen period and why, line by line, without posting anything.

#### Scenario: Explanation without side effects
- **WHEN** an admin opens the fee calculator for Q3
- **THEN** the lines, proration and discounts are shown and no assessment or invoice is created

### Requirement: Invoice line text template (should)
The system SHALL build invoice line text from a template with placeholders for plan name, period start, period end and member number.

#### Scenario: Line text rendered
- **WHEN** the template is `{plan} {period_start}–{period_end}`
- **THEN** a line reads "Erwachsene 01.01.2027–31.03.2027"

### Requirement: Fee run preview
The system SHALL create a fee run for a due date and a member selection (all, a saved view, a division) as a preview that lists every member and household with each line (plan, period, proration, discount, admission fee, credit offset, catch-up periods) and the total, and warns about missing payment method, missing or inactive mandate, missing payer, amount 0 and members in `resigned` status; catch-up lines for retroactive periods SHALL be grouped, labelled and excludable per member; runs over 100 members SHALL execute as background jobs.

#### Scenario: Catch-up lines
- **WHEN** a member is entered with a join date four months in the past under a monthly plan
- **THEN** the preview shows four labelled catch-up lines that the treasurer can exclude

#### Scenario: Warning for missing mandate
- **WHEN** a member pays by direct debit without an active mandate
- **THEN** the preview lists the member under the warning "mandate missing or not active"

### Requirement: Double-billing guard
The system SHALL never hold two live (not `cancelled`) assessments of the same member that cover the same day in the same charge slot (`main` or the add-on plan), enforced by a database constraint; a second run over the same period, a plan switch, an interval change or a shifted proration start SHALL create nothing for days already billed and SHALL report this in the preview.

#### Scenario: Same period twice
- **WHEN** a fee run for January is posted a second time
- **THEN** no assessment is created and the preview states that January is already billed

#### Scenario: Interval change
- **WHEN** a member billed quarterly for January–March switches to monthly from February
- **THEN** February and March are not billed again

### Requirement: Preview snapshot and posting
The system SHALL treat the preview as a snapshot: posting SHALL fail with "data changed since preview" when any input changed and offer to re-preview, and posting SHALL create the assessments and invoices in resumable chunks so that a crash never creates duplicates.

#### Scenario: Stale preview
- **WHEN** a fee assignment changes after the preview and the treasurer clicks "post"
- **THEN** posting fails with "data changed since preview" and nothing is created

### Requirement: Fee run cancellation
The system SHALL cancel a posted fee run only as a whole by issuing cancellation documents for its invoices, moving its assessments to `cancelled` so the periods can be assessed again.

#### Scenario: Re-assess after cancellation
- **WHEN** a posted run is cancelled
- **THEN** cancellation documents exist for its invoices and a new run can bill the same periods

### Requirement: Scheduled fee run previews (should)
The system SHALL optionally create fee-run previews on a schedule per organisation (for example monthly on a set day, or N days before each period start) and notify the treasurer; posting SHALL still require a click.

#### Scenario: Scheduled preview not posted
- **WHEN** the schedule fires
- **THEN** a preview exists, the treasurer is notified and no invoice is issued

### Requirement: Invoice lifecycle and immutability
The system SHALL issue invoices of kind membership, other receivable, credit note and cancellation document with lines (text, quantity, unit price in cents, tax rate, ledger account, sphere, cost centre, several tax rates allowed) and states `draft` → `issued` → `open` / `partially_paid` / `paid`, plus `cancelled` and `written_off`; issuing SHALL assign a gapless number from the configured range in the issuing transaction and make the content immutable; corrections SHALL only be made by a cancellation document with its own number range that references the original.

#### Scenario: Issued invoice cannot change
- **WHEN** a user edits a line of an issued invoice
- **THEN** the system refuses and offers a cancellation document

#### Scenario: Gapless numbers
- **WHEN** two invoices are issued concurrently
- **THEN** they receive consecutive numbers with no gap and no duplicate

### Requirement: Recurring invoice templates
The system SHALL keep recurring invoice templates with interval in months, next date and end date, and a daily job SHALL create a draft or issue directly as set per template.

#### Scenario: Template due
- **WHEN** a template's next date is today and it is set to "draft"
- **THEN** the job creates a draft invoice and advances the next date by the interval

### Requirement: Invoice PDF with EPC QR code
The system SHALL render issued invoices on the letterhead with an EPC QR code (GiroCode, version 002, BCD) carrying IBAN, amount and the invoice number as reference, store the PDF once with its SHA-256 and never re-render it, so that every re-download returns the same bytes.

#### Scenario: Same bytes on re-download
- **WHEN** an issued invoice PDF is downloaded twice, months apart, after a letterhead change
- **THEN** both downloads have the same SHA-256

### Requirement: Net or gross prices and cover texts (should)
The system SHALL let each line's unit price be entered net ("zzgl.") or gross ("inkl.") and let an invoice carry a cover text and a closing text with placeholders.

#### Scenario: Gross entry
- **WHEN** a line is entered as 11900 cents gross at 19 %
- **THEN** the invoice shows 10000 cents net and 1900 cents tax

### Requirement: Open items and dunning
The system SHALL list open and partially paid receivables and payables with recipient, date, number, amount, open amount (computed from allocations, never edited), due date, dunning level, last dunning date and collection-run state; dunning levels (delay days, fee, letter template) SHALL be configured per organisation; "propose dunning" SHALL list invoices that reached the next level, and applying a level (creating a `dunning_event`) and sending it SHALL be separate visible steps; a dunning fee SHALL be a new line or a separate invoice, never an edit of the issued invoice.

#### Scenario: Dunning proposal
- **WHEN** an invoice is 14 days overdue and level 1 has 14 delay days
- **THEN** it appears in "propose dunning" for level 1

#### Scenario: Fee as separate document
- **WHEN** a level with a 500-cent fee is applied
- **THEN** the fee is added as a new invoice or line and the original issued invoice is unchanged

### Requirement: Dunning hold (should)
The system SHALL let dunning be put on hold for an invoice until a date with a reason, and held invoices SHALL be left out of "propose dunning" until then.

#### Scenario: Held invoice
- **WHEN** an invoice is on hold until 30 June
- **THEN** it does not appear in "propose dunning" before 30 June

### Requirement: Write-off
The system SHALL write off the open amount of an invoice with a reason by booking it to a configurable account and moving the invoice to `written_off`, reversible only by a reversal entry.

#### Scenario: Uncollectible amount
- **WHEN** a treasurer writes off an open amount of 4500 cents with reason "Mitglied verzogen, unbekannt"
- **THEN** 4500 cents are booked to the write-off account and the invoice is `written_off`

### Requirement: Zero-amount lines are recorded without an invoice
The system SHALL record assessments for preview lines of 0 cents (for example honorary members) so the period counts as billed, but SHALL NOT issue an invoice whose total is 0 cents; the preview SHALL warn about such members.

#### Scenario: Honorary member
- **WHEN** a fee run posts a member whose only line is 0 cents
- **THEN** an assessment exists for the period and no invoice is issued

### Requirement: PDF frozen at issue
The system SHALL freeze the recipient address and the letterhead into the invoice when it is issued, render the PDF from that snapshot (at issue or on first download), store it once with its SHA-256, and refuse any later change of the stored bytes.

#### Scenario: Letterhead changed after issue
- **WHEN** the club name changes after an invoice was issued and its PDF is downloaded again
- **THEN** the bytes are identical to the first download and show the old name

### Requirement: Payments cannot exceed the open amount
The system SHALL refuse a manual payment larger than the open amount of the invoice, SHALL recompute the paid amount and status (`open`, `partially_paid`, `paid`, `written_off`) from confirmed allocations after every payment, write-off or reversal, and SHALL refuse to cancel an invoice while confirmed payments are allocated to it.

#### Scenario: Overpayment
- **WHEN** a treasurer records 6000 cents on an invoice with 5000 cents open
- **THEN** the request is refused with a field error and nothing is booked

