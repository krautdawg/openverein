# communication Specification

## Purpose
The communication capability covers bulk e-mail through the club's SMTP relay with templates, placeholders, attachments, a delivery log and suppression, and the letterhead with printable PDF letter batches split by preferred channel (B M27, M28). Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour. Free serial letters and a layout editor are post-MVP (B P27) and not specified here.
## Requirements
### Requirement: Recipient selection with exclusions
The system SHALL take recipients from a saved view, groups or a hand-picked list and preview the count and the excluded persons with their reason (no e-mail, opted out, suppressed, former member).

#### Scenario: Exclusions listed
- **WHEN** a mail to group "Senioren" includes a person without e-mail and one on the suppression list
- **THEN** the preview lists both as excluded with their reasons

### Requirement: Composer with permission-aware placeholders
The system SHALL offer a rich-text editor with placeholders (for example `{{person.first_name}}`, `{{member.number}}`, `{{invoice.open_amount}}`, custom fields) and a live preview for any chosen recipient; placeholders SHALL resolve through the same field permissions as the UI, and templates SHALL render in a sandbox that cannot execute code.

#### Scenario: Restricted placeholder
- **WHEN** a trainer without the IBAN right uses an IBAN placeholder
- **THEN** the placeholder does not resolve to the IBAN

#### Scenario: Preview per recipient
- **WHEN** the sender picks a recipient in the preview
- **THEN** the mail is shown with that recipient's values filled in

### Requirement: Templates and system templates
The system SHALL keep versioned templates with categories and ship system templates for: application received, accepted and rejected; change request decided; resignation confirmed; pre-notification; dunning; portal invitation; sign-in code.

#### Scenario: System template used
- **WHEN** an application is accepted
- **THEN** the "application accepted" template is sent to the applicant

### Requirement: Attachments
The system SHALL allow attachments up to 10 MB in total per mail and per-recipient generated PDFs (for example the recipient's own invoice).

#### Scenario: Per-recipient invoice
- **WHEN** a mail is sent with "attach own invoice"
- **THEN** each recipient receives only their own invoice PDF

#### Scenario: Size limit
- **WHEN** attachments exceed 10 MB in total
- **THEN** the mail cannot be sent until attachments are reduced

### Requirement: SMTP sending
The system SHALL send through the club's SMTP relay, optionally with sender addresses per purpose (finance, board, general), and offer a "test SMTP" action with SPF, DKIM and DMARC hints.

#### Scenario: Test mail
- **WHEN** an admin runs "test SMTP"
- **THEN** a test mail is sent and the result with SPF / DKIM / DMARC hints is shown

### Requirement: Throttled queue and delivery log
The system SHALL queue mails with a configurable rate (messages per minute) and keep one delivery row per recipient with status `queued`, `accepted`, `bounced`, `failed` or `printed` and error text; each sent mail SHALL appear on the recipient's profile timeline.

#### Scenario: Throttle
- **WHEN** 600 mails are queued with a limit of 100 per minute
- **THEN** sending takes at least 6 minutes and each recipient's delivery status is recorded

### Requirement: Bounces and suppression
The system SHALL log synchronous SMTP rejects per recipient, accept asynchronous bounces through a relay webhook adapter, let an admin mark an address as bounced by hand, and add hard-bounced addresses to the suppression list.

#### Scenario: Hard bounce
- **WHEN** the relay webhook reports a hard bounce
- **THEN** the delivery becomes `bounced` and the address is suppressed for later mails

### Requirement: Unsubscribe for non-mandatory mail
The system SHALL add an unsubscribe link to non-mandatory categories (for example newsletter); mandatory club notices (general assembly invitation, invoices, pre-notifications) SHALL NOT be suppressible by unsubscribe, only by hard bounce.

#### Scenario: Unsubscribed member still gets invoice
- **WHEN** a member who unsubscribed from the newsletter is sent an invoice
- **THEN** the invoice mail is delivered

### Requirement: Letterhead
The system SHALL keep one letterhead configuration (logo, sender line, address block for DIN 5008 window envelopes type A or B, footer with board members, register court and number, tax number and bank details) used by every generated document: invoice, cancellation, dunning letter, donation receipt, mandate form, pre-notification, membership confirmation and GDPR data sheet.

#### Scenario: Window envelope
- **WHEN** an invoice is printed with DIN 5008 type B
- **THEN** the recipient address sits in the type-B window position

### Requirement: Send documents by preferred channel
The system SHALL split document recipients by preferred channel and show the split (N by e-mail, M as letters, K without a valid channel) before sending, and record for each document how and when it was sent.

#### Scenario: Channel split
- **WHEN** 120 invoices are sent and 20 recipients prefer letters and 3 have no channel
- **THEN** the dialog shows 97 by e-mail, 20 as letters and 3 without a valid channel

### Requirement: Printable letter batches
The system SHALL merge letters into one PDF in postal-code order with blank pages added where needed for duplex printing, and store and list the batch with its documents.

#### Scenario: Duplex padding
- **WHEN** a batch contains a 3-page letter followed by another letter
- **THEN** a blank page is inserted so that the next letter starts on a new sheet

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

