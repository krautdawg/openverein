## ADDED Requirements

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
