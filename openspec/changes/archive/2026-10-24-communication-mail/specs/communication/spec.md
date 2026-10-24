## ADDED Requirements

### Requirement: Fixed placeholder list
The system SHALL offer placeholders only from a fixed list (first name, last name, full name, membership number, club name, and for invoice mails invoice number, amount, open amount, due date, dunning label) and leave unknown placeholders visible in the preview.

#### Scenario: Unknown placeholder
- **WHEN** the text contains `{{iban}}`
- **THEN** the preview and the mail show `{{iban}}` unchanged

### Requirement: Invoice mail by preferred channel
The system SHALL send issued invoices of a list or a fee run by e-mail with each recipient's own PDF and return the invoices whose recipients prefer letters or have no deliverable address for printing.

#### Scenario: Letter preferred
- **WHEN** invoices are sent and one recipient prefers letters
- **THEN** that invoice is listed for printing and not mailed
