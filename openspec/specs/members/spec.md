# members Specification

## Purpose
The members capability covers member records and their lifecycle, the shared address book for members and non-members, custom fields, households with payer and family discount, faceted member lists with saved views, CSV / XLSX export, bulk actions and duplicate detection (B M01, M02, M03, M05, M06, M07, M08, M09). Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.
## Requirements
### Requirement: Member records and numbers
The system SHALL link each member 1:1 to a person, never delete the person when a membership ends, and generate a member number unique per organisation from a configurable pattern (for example `M-{YYYY}-{seq:4}`) that only users with the `members.number.edit` permission may change, and only before first save.

#### Scenario: Number from pattern
- **WHEN** the first member of 2027 is saved with pattern `M-{YYYY}-{seq:4}`
- **THEN** the member gets number `M-2027-0001`

#### Scenario: Person survives membership
- **WHEN** a membership is removed
- **THEN** the linked person remains in the address book

### Requirement: Member lifecycle statuses
The system SHALL use the statuses `applicant`, `future`, `active`, `resigned`, `former` and `rejected`, change them only through explicit dated actions that write an audit event, move `future` to `active` and `resigned` to `former` by a nightly job on the respective dates, and show a status timeline with dates and acting admin on the profile.

#### Scenario: Future member activates
- **WHEN** the join date of a `future` member is reached
- **THEN** the nightly job sets the status to `active` and the timeline shows the change

#### Scenario: No free status edit
- **WHEN** a user tries to set the status field directly through an update
- **THEN** the system rejects it and points to the transition actions

### Requirement: Notice and exit dates
The system SHALL require an exit date whenever a notice date is set, propose the exit date from the organisation's notice rule (for example end of quarter with 6 weeks' notice), warn when the entered exit date breaks the rule, reject an exit date before the join date, and take the exit reason from a configurable list.

#### Scenario: Proposed exit date
- **WHEN** notice is received on 10 May under the rule "end of quarter, 6 weeks' notice"
- **THEN** the proposed exit date is 30 June

#### Scenario: Exit before join
- **WHEN** an exit date earlier than the join date is entered
- **THEN** the system rejects it

### Requirement: Former members hidden by default
The system SHALL hide `former` members from every list, filter result, export and mail recipient picker by default and show them only through a visible "include former members" toggle whose state is saved with the view.

#### Scenario: Default list
- **WHEN** an admin opens the member list without changing filters
- **THEN** no former member is listed

#### Scenario: Toggle saved
- **WHEN** a view is saved with "include former members" switched on
- **THEN** reopening the view shows former members

### Requirement: Profile data-quality warnings (should)
The system SHALL show warnings in the member profile header for: no payment method, no mandate where the method is direct debit, no contact data, and user has admin access.

#### Scenario: Missing mandate warning
- **WHEN** a member pays by direct debit and has no active mandate
- **THEN** the profile header shows the warning "no mandate"

### Requirement: Shared address book
The system SHALL keep one person record for natural persons and organisations (company name, contact person) with several addresses (private, business, invoice), e-mails with one preferred, phones and a preferred channel (`email`, `letter`, `none`); non-members SHALL be convertible into applicants or members without re-entering data; address groups SHALL hold members and non-members; DATEV debtor and creditor numbers SHALL be auto-assigned on first use from configurable ranges (default debtors 10000–69999, creditors 70000–99999); archiving SHALL remove a person from pickers, and anonymising SHALL only be possible through the GDPR tooling.

#### Scenario: Convert sponsor to member
- **WHEN** an admin converts a non-member sponsor into an applicant
- **THEN** the existing person data is reused and a member record is added

#### Scenario: Debtor number on first invoice
- **WHEN** the first invoice is issued to a person without a debtor number
- **THEN** the next free number in the debtor range is assigned

### Requirement: Address country validation (should)
The system SHALL store a country code (DE, AT, CH, other), state and address supplement per address and validate the postal code by country: 5 digits for DE, 4 digits for AT and CH, free text otherwise.

#### Scenario: Austrian postal code
- **WHEN** an address with country AT and postal code `1010` is saved
- **THEN** it is accepted, while `10115` is rejected for AT

### Requirement: Custom fields
The system SHALL let admins define custom fields on persons or members of type text, multiline text, number, date, checkbox, select, multiselect or file, with label, i18n key, tab, position, required flag, options and the flags `visible_to_member`, `editable_by_member`, `needs_approval`, `sensitive` and `gdpr_relevant`; custom fields SHALL be usable as list filters, columns, export columns, import targets and mail placeholders; a field's type SHALL be fixed once values exist; archiving SHALL hide a field and keep its values; deleting a field with values SHALL require typing its name and write an audit event.

#### Scenario: Type locked
- **WHEN** an admin changes the type of a field that has values
- **THEN** the system refuses and suggests archiving it and creating a new field

#### Scenario: Placeholder
- **WHEN** a mail uses `{{custom.shirt_size}}`
- **THEN** each recipient's value is inserted, unless the sender may not see that field

### Requirement: Households with payer and family discount
The system SHALL model households with a name, a payer person who need not be a member, an optional billing address override and an effective-dated discount rule (none, percentage off from the 2nd or 3rd member, fixed family cap per period, children free from the n-th child); household members SHALL be invoiced on one invoice to the payer with one line per member and fee, collected with the payer's mandate, and the fee-run preview SHALL show the discount as its own line naming the rule; removing the payer SHALL require choosing a new payer first.

#### Scenario: One invoice per household
- **WHEN** a fee run bills a household of three members
- **THEN** one invoice to the payer is created with one line per member and a discount line

#### Scenario: Payer removal
- **WHEN** an admin removes the payer without naming a new one
- **THEN** the system refuses

### Requirement: Member lists with faceted search and saved views
The system SHALL offer global search over name, member number, e-mail and city with typo tolerance, facets (status, group on a date, age range, join and exit date ranges, payment method, mandate state, household, open balance above 0, custom fields) that combine with AND across facets and OR within one facet, a keyboard-operable column picker with per-user width and sort, and saved views that are private or shared with a role; a shared view SHALL omit columns the viewer may not see; IBANs SHALL NOT be searchable by fragment, only by exact full IBAN for users with the IBAN right; the first page of 2,000 members with 10 columns SHALL render in under 500 ms server time.

#### Scenario: Shared view respects permissions
- **WHEN** a trainer opens a shared view that contains an IBAN column
- **THEN** the column is omitted for the trainer

#### Scenario: IBAN fragment search
- **WHEN** a user searches for `DE89 3704`
- **THEN** no member is found through the IBAN

### Requirement: CSV and XLSX export of filtered lists
The system SHALL export exactly the current filter, columns and sort as CSV (UTF-8 with BOM, `;` separator, optional German decimal comma) or XLSX (typed dates and numbers), omit restricted fields from the offered columns, escape CSV cells starting with `=`, `+`, `-` or `@`, run exports over 1,000 rows as background jobs with the file kept for 7 days, and audit-log every export with filter, columns and row count but not the data.

#### Scenario: Formula injection
- **WHEN** a name field contains `=HYPERLINK(...)`
- **THEN** the exported CSV cell is escaped so spreadsheet software shows it as text

#### Scenario: Large export
- **WHEN** an export covers 1,500 rows
- **THEN** it runs as a background job and the file is deleted after 7 days

### Requirement: Bulk actions on filtered lists
The system SHALL apply actions (send e-mail or letter, create manual invoice, add to or end group membership, status transition, export, accept or reject applications, duplicate check, GDPR data sheet, portal invitations) to all filter results across pages, the current page or hand-picked rows; it SHALL show a confirmation with the count and a sample of 5 records, freeze the selection as an id snapshot at confirmation, check permissions per record and report skipped records, run actions over 100 records as background jobs with a per-record result (succeeded, skipped with reason, failed), and audit-log every bulk action with its id snapshot.

#### Scenario: Out-of-scope records skipped
- **WHEN** a division lead runs a bulk group change on a selection that includes members outside their scope
- **THEN** those members are skipped and listed with the reason

#### Scenario: Selection frozen
- **WHEN** a member matching the filter is added after the bulk action was confirmed
- **THEN** that member is not processed

### Requirement: Duplicate detection
The system SHALL find likely duplicate persons on import and on demand with a score from name similarity, date of birth, e-mail, IBAN and address, a threshold adjustable from 60 to 100 %, and a result list of pairs with the matching fields highlighted; the admin SHALL resolve a pair by archiving the duplicate that has no financial records, and "not a duplicate" decisions SHALL be remembered.

#### Scenario: Pair dismissed
- **WHEN** an admin marks a pair as "not a duplicate"
- **THEN** the pair is not proposed again

#### Scenario: Threshold
- **WHEN** the threshold is set to 90 %
- **THEN** only pairs scoring 90 % or more are listed

### Requirement: Member search tolerates typos and umlauts
The system SHALL find members by any part of first or last name, company, member number, town or (when visible to the user) e-mail, ignoring case and accents (`muller` finds `Müller`, `yilmaz` finds `Yılmaz`), tolerate small typos in names (`schmitt` finds `Schmidt`), and treat `%` and `_` in the query as literal characters.

#### Scenario: Umlaut-free search
- **WHEN** an admin searches for `muller`
- **THEN** the member `Müller, Jörg` is listed

#### Scenario: Wildcards are literal
- **WHEN** an admin searches for `%`
- **THEN** no member is listed unless a name contains a percent sign

### Requirement: Keyboard-first member list
The system SHALL let users work the member list without a mouse: `/` focuses search, `n` opens the create form, arrow keys (or `j`/`k`) move between rows, Enter opens the record in a side sheet, Space selects a row for bulk actions, and the command palette finds members by name.

#### Scenario: Open a member by keyboard
- **WHEN** a user presses `/`, types a name, tabs into the list and presses Enter on a row
- **THEN** the member opens in a side sheet over the list

### Requirement: Sensitive custom fields stay with club-wide readers
The system SHALL hide sensitive custom fields and their values from users whose member access is limited to groups, SHALL never offer them as mail placeholders, and SHALL record changes to them in the audit log without the values.

#### Scenario: Trainer opens a profile
- **WHEN** a trainer limited to the tennis group opens a member with an allergy noted in a sensitive field
- **THEN** neither the field nor its value is shown or returned by the API

### Requirement: Household discount recomputed from included lines
The system SHALL compute a household's discount at posting from the lines that are actually billed, so excluding a preview line changes the discount accordingly.

#### Scenario: Excluded child fee
- **WHEN** the preview of a household with "50 % from the 2nd member" is posted with one child's fee excluded
- **THEN** the discount line covers only the remaining discounted fees

