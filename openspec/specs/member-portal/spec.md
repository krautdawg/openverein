# member-portal Specification

## Purpose
The member-portal capability covers the member portal as an installable PWA, data change requests with admin approval, and the public online membership application with SEPA mandate capture (B M29, M30, M31). Sign-in mechanics are specified in the auth capability. Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.
## Requirements
### Requirement: Portal pages
The system SHALL give signed-in members: my profile (fields marked visible; editable ones through change requests), my memberships and groups (without admins-only groups), my SEPA mandate (masked IBAN, reference, signature date), my invoices with PDF download, open amount and EPC QR code, my donation receipts, my documents, and a resignation request.

#### Scenario: Own invoices
- **WHEN** a member opens "my invoices"
- **THEN** their invoices are listed with open amount and PDF download, and an open invoice shows its EPC QR code

### Requirement: Self-only data access
The system SHALL return through portal endpoints only data about the signed-in person and, for a household payer, the household's invoices, enforced in the API and by row-level security.

#### Scenario: Other member's invoice
- **WHEN** a member requests another member's invoice id through the portal API
- **THEN** the response is 404

#### Scenario: Household payer
- **WHEN** a household payer opens "my invoices"
- **THEN** all household invoices are listed

### Requirement: Resignation request
The system SHALL let a member submit a resignation with a proposed exit date computed from the notice rule; submission SHALL create a task for admins and send a confirmation mail, and an admin's confirmation SHALL set the notice and exit dates on the member.

#### Scenario: Resignation confirmed
- **WHEN** an admin confirms a portal resignation request
- **THEN** the member's notice and exit dates are set and the member's status becomes `resigned`

### Requirement: Portal as PWA
The system SHALL deliver the portal as an installable PWA that works on a 390 px wide phone and shows a clear offline state without offline writes.

#### Scenario: Phone width
- **WHEN** the portal is opened at 390 px width
- **THEN** every page is usable without horizontal scrolling

### Requirement: Portal function settings (should)
The system SHALL let the organisation switch portal functions on or off (edit own data, request bank-data changes, show invoices, show the mandate, resignation request, show the admin contact), each overridable per group with allow, deny or default; a member SHALL get a function if any current group allows it and none denies it.

#### Scenario: Deny wins
- **WHEN** one of a member's groups allows "show invoices" and another denies it
- **THEN** the member does not see invoices

### Requirement: Change request rules
The system SHALL treat each member-editable field as "apply immediately" or "needs approval", with IBAN and name always needing approval, store each request with old value, proposed value, requester and time, keep only one pending request per field with a newer one superseding the older, and notify the old e-mail address when e-mail or IBAN changes.

#### Scenario: Immediate field
- **WHEN** a member changes their phone number and the field applies immediately
- **THEN** the new number is saved without approval

#### Scenario: Superseded request
- **WHEN** a member submits a second address change while the first is pending
- **THEN** the first request is marked superseded

### Requirement: Change request decisions
The system SHALL show admins an inbox with a diff per request, let them accept or deny with a reason, apply accepted changes through the same validation and audit as an admin edit, and mail the member the decision.

#### Scenario: Denied change
- **WHEN** an admin denies a name change with a reason
- **THEN** the member receives a mail with the reason and the name stays unchanged

### Requirement: Bank change creates mandate amendment
The system SHALL record an accepted IBAN change as a mandate amendment and ask the admin whether a new signed mandate is required.

#### Scenario: IBAN change accepted
- **WHEN** an admin accepts a new IBAN
- **THEN** the mandate history shows an amendment with the date, and the admin is asked about a new signed mandate

### Requirement: Application forms
The system SHALL build application forms from blocks (personal data, address, contact, groups offered, fee plan choice, custom fields, SEPA mandate with mandate text, versioned consent checkboxes, privacy notice link, guardian section for minors), publish them at a public URL, as an iFrame snippet with configurable allowed origins and as a QR code.

#### Scenario: Embedding restricted
- **WHEN** a site not in the form's allowed origins embeds the form
- **THEN** the browser refuses to render it

### Requirement: Application spam protection
The system SHALL protect public forms without third-party services by a honeypot field, a rate limit per IP and a minimum fill time, with optional e-mail double opt-in before the application is shown to admins.

#### Scenario: Bot submission
- **WHEN** a submission fills the honeypot field or arrives 2 seconds after the form loaded
- **THEN** it is not shown in the admin inbox

### Requirement: Immutable application record
The system SHALL store each submission immutably with data, consent text versions, timestamp and hashed IP, and confirm it by mail with a PDF copy.

#### Scenario: Payload unchanged
- **WHEN** an admin edits data while accepting an application
- **THEN** the stored submission payload stays unchanged

### Requirement: Application decisions
The system SHALL let admins accept (creating person, member in `active` or `future`, group memberships, fee assignment and mandate in one transaction, after a duplicate check), reject with a mail, or mark as spam, singly or in bulk.

#### Scenario: Accept creates records
- **WHEN** an admin accepts an application with a division and direct debit
- **THEN** person, member, group membership, fee assignment and mandate are created together, or none of them on error

### Requirement: Online mandate capture
The system SHALL activate a mandate from the form (signature date = submission date, evidence = submission record) only if the organisation has recorded its bank's agreement to electronic mandates; otherwise it SHALL create the mandate as `pending_evidence`, send a pre-filled mandate PDF for signature and show the admin that a debit without valid mandate can be reclaimed for 13 months; for applicants under 18 the debtor SHALL be the account holder captured as a separate person, never the minor.

#### Scenario: No bank agreement
- **WHEN** an application with a mandate is accepted and no bank agreement is recorded
- **THEN** the mandate is `pending_evidence` and a mandate PDF is sent for signature

#### Scenario: Minor applicant
- **WHEN** a 12-year-old applies with a parent's account
- **THEN** the parent is created as a separate person and is the mandate's debtor

### Requirement: Join date rule on acceptance (should)
The system SHALL set the join date on acceptance by an organisation rule (application date, acceptance date, 1st of the application month, or 1st of the following month, overridable per application) and assign the member number from the pattern.

#### Scenario: First of next month
- **WHEN** an application from 14 March is accepted under the rule "1st of the following month"
- **THEN** the join date is 1 April and the member is `future` until then

### Requirement: Contact forms (could)
The system SHALL let a form be a contact form that creates a non-member person in a chosen address group, with the same spam protection and consent records.

#### Scenario: Sponsor contact
- **WHEN** a contact form for address group "Sponsoren" is submitted
- **THEN** a non-member person is created in that group with the consent record

### Requirement: Portal identity by e-mail address
The system SHALL sign members in per e-mail address and show every current membership whose person has that address, so a parent sees the memberships of children registered under the same address.

#### Scenario: Family under one address
- **WHEN** a parent and a child share an e-mail address and the parent signs in
- **THEN** the portal shows both memberships and the invoices addressed to either of them

### Requirement: Fixed field rules for change requests
The system SHALL apply phone number changes immediately and hold changes of name, e-mail address, postal address and IBAN for approval.

#### Scenario: Address waits
- **WHEN** a member changes their city in the portal
- **THEN** the member record keeps the old city until an admin accepts the request

### Requirement: Fixed application blocks
The system SHALL build application forms from fixed blocks (personal data, address, contact, offered groups, offered fee plans, optional SEPA mandate, guardian section for applicants under 18, consent with privacy link) configured per form.

#### Scenario: Guardian for minors
- **WHEN** an applicant enters a birth date less than 18 years ago
- **THEN** the form asks for a guardian, refuses submission without one, and refuses a mandate whose account holder is the applicant

### Requirement: Member-visible custom fields in the portal
The system SHALL show a member, in the portal, the values of custom fields the club marked as visible to members, and no other custom fields.

#### Scenario: Internal field stays hidden
- **WHEN** a member with a shirt size (visible to members) and an internal note opens the portal
- **THEN** the shirt size is shown and the internal note is not

### Requirement: Expense claims from the portal
The system SHALL let members submit expense claims with a receipt file in the portal, and let the treasurer accept a claim into an open receipt (with that file) or reject it with a reason the member sees.

#### Scenario: Accepted claim
- **WHEN** the treasurer accepts a claim of 12,80 € and chooses an expense account
- **THEN** an open receipt of 12,80 € with the member's receipt file exists, and the member sees the claim as accepted

### Requirement: Household proxy
The system SHALL let the payer of a household manage the household's memberships in the portal, while members with their own e-mail address can only resign themselves.

#### Scenario: Child without e-mail
- **WHEN** the payer signs in to the portal
- **THEN** the child's membership is shown as managed by the payer and can be changed or resigned

### Requirement: Member polls
The system SHALL let the board run polls that eligible members answer once per membership in the portal, show members results only after the end, and show the board only counts.

#### Scenario: Group poll
- **WHEN** a poll is limited to the board group
- **THEN** members outside the group do not see it and cannot answer it

### Requirement: Expense decision mail
The system SHALL e-mail the member when their expense claim is approved or rejected, including the reason for a rejection.

#### Scenario: Rejected claim
- **WHEN** the treasurer rejects a claim with the reason "Beleg unleserlich"
- **THEN** the member receives an e-mail saying the claim is rejected with that reason

### Requirement: Member profile in the portal
The system SHALL let a member keep a profile for each membership under their address in the portal: display name, bio, place, organisation, an optional photo, an ordered list of links, a profile type from the club's list (default `none`) and the contact visibility (board by default, members or public). The member SHALL be able to hide the profile at any time.

#### Scenario: Hide at once
- **WHEN** a member with a public profile hides it
- **THEN** the next request to the public feed no longer lists it

#### Scenario: Change needs approval again
- **WHEN** a member changes the bio of an approved profile
- **THEN** the profile is no longer public until the board approves it again

### Requirement: Profile photo needs consent
The system SHALL serve a profile photo publicly only while the member has an active consent for the purpose `photos`.

#### Scenario: Consent withdrawn
- **WHEN** a member withdraws the `photos` consent
- **THEN** the public feed shows no photo for them and the photo URL answers 404

### Requirement: Board approval and public feed
The system SHALL list a profile publicly only if its type is not `none`, the board approved its current version, it is not hidden and the membership is current. It SHALL offer a read-only feed per club with CORS for any origin, short cache headers and a rate limit, and SHALL include the contact e-mail only when its visibility is public.

#### Scenario: Not approved
- **WHEN** a member sets their type to Profi
- **THEN** the feed does not list them until an admin approves the profile

### Requirement: Import of KI Klub profiles
The system SHALL offer a dry-run-first import of KI Klub profiles, links and photos, matched to members by e-mail, reporting what it would create, update or skip before writing.

#### Scenario: Dry run
- **WHEN** the importer runs without the confirm flag
- **THEN** it reports the planned changes and writes nothing

