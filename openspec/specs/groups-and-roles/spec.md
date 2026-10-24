# groups-and-roles Specification

## Purpose
The groups-and-roles capability covers groups and divisions with dated membership, roles and permissions by module, division scope and field level including the built-in tax-adviser and cash-auditor roles, and the append-only audit log (B M04, M32, M35). Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.

## Requirements
### Requirement: Groups and divisions
The system SHALL support groups of kind `division`, `segment`, `board` and `team`, each with name, unique short code, colour shown as a badge in lists, an optional parent group (one level) and a flag for offering the group in the public application form.

#### Scenario: Unique short code
- **WHEN** an admin creates a group with a short code that already exists in the organisation
- **THEN** the system rejects it

#### Scenario: Badge in list
- **WHEN** the member list shows a member of group "Jugend"
- **THEN** a badge in the group's colour is shown

### Requirement: Dated group membership
The system SHALL record each group membership with `valid_from` and optional `valid_to`, reject overlapping memberships of the same member in the same group, show the group change history on the member profile, and answer membership questions for any date.

#### Scenario: Overlap rejected
- **WHEN** a member already in "U17" from 1 January with no end is added again from 1 March
- **THEN** the second membership is rejected

#### Scenario: Membership on a date
- **WHEN** an admin lists group "U17" on 1 March 2026
- **THEN** exactly the members whose membership spans that date are shown

### Requirement: Admin-only groups
The system SHALL let a group be marked "admins only"; such a group SHALL never appear in the member portal, in member-facing documents or in mails to the member.

#### Scenario: Hidden in portal
- **WHEN** a member of the admins-only group "Mahnliste" opens "my groups" in the portal
- **THEN** that group is not listed

### Requirement: Groups do not carry fees
The system SHALL keep fees out of groups; a group MAY suggest a default fee plan that is applied as a separate fee assignment only after confirmation when a member joins the group.

#### Scenario: Suggested fee plan
- **WHEN** a member is added to a group with a default fee plan
- **THEN** the admin is asked to confirm creating the fee assignment, and nothing is assigned without confirmation

### Requirement: Module permissions and built-in roles
The system SHALL grant `none`, `read` or `write` per module (members, persons, groups, fees, invoices, SEPA, banking, ledger, donations, communication, documents, settings, audit, imports / exports, API) and ship the built-in roles Admin, Treasurer, Division lead, Trainer, Member (portal), Tax adviser and Cash auditor, which cannot be edited, only copied; admins and external users such as the tax adviser need not be members and there is no seat limit.

#### Scenario: Built-in role immutable
- **WHEN** an admin edits the built-in Treasurer role
- **THEN** the system refuses and offers to copy it into a custom role

#### Scenario: External tax adviser
- **WHEN** an admin creates a user for the tax adviser without a member record
- **THEN** the user can sign in with the Tax adviser role

### Requirement: Division scope
The system SHALL scope role grants to the whole organisation or to a set of groups with optional validity dates, and enforce scope in the application and in row-level security: multi-division members are visible to every lead of any of their divisions; household invoices show a lead only the lines of in-scope members plus the payer's name and address; non-member payers appear only as payer; address-book persons appear only through granted address groups; former members of scoped groups stay readable for 12 months.

#### Scenario: Out-of-scope member
- **WHEN** the lead of "Tennis" requests a member who is only in "Fußball"
- **THEN** the API answers as if the record did not exist in their scope

#### Scenario: Household invoice partly in scope
- **WHEN** a division lead opens a household invoice with lines for one in-scope and one out-of-scope member
- **THEN** only the in-scope line and the payer's name and address are shown, not the total

### Requirement: Field-level restrictions
The system SHALL restrict fields (IBAN, date of birth, sensitive custom fields, internal notes) per role, and restricted fields SHALL be omitted from the UI, API responses, exports, mail placeholders, PDFs, search results and audit diffs; the tax-adviser role SHALL see persons only with name, address and debtor / creditor number.

#### Scenario: Trainer sees no IBAN
- **WHEN** a trainer opens a member profile or exports the member list
- **THEN** the IBAN appears in neither

#### Scenario: Tax adviser projection
- **WHEN** a tax adviser opens a person
- **THEN** only name, address and debtor / creditor number are returned

### Requirement: Check permissions view
The system SHALL offer a "check permissions" view that shows, for a chosen user, the effective rights per module, the scope and the restricted fields, computed by the same policy functions that enforce access.

#### Scenario: Effective rights
- **WHEN** an admin checks a user who holds Trainer for "U17"
- **THEN** the view lists read on members scoped to "U17" and the restricted fields IBAN and date of birth as configured

### Requirement: Machine-readable authorisation denials
The system SHALL answer every authorisation denial on the API with an RFC 9457 problem document that names the missing permission.

#### Scenario: Denied write
- **WHEN** a read-only user sends a write request
- **THEN** the response is 403 with a problem document naming the missing permission

### Requirement: Jobs act with current grants
The system SHALL run user-started jobs as their actor, reload that actor's grants at the start of every chunk and stop the job when the user is deactivated or the grant revoked; system jobs SHALL run as a `system` actor with a fixed permission set shown in the audit log.

#### Scenario: Grant revoked mid-job
- **WHEN** a user's role grant is revoked while their bulk job is running
- **THEN** the job stops at the next chunk and reports why

### Requirement: Audit events
The system SHALL record in the audit log every create, update and delete-equivalent with field-level before / after values (masked for users without the field right), status transitions, logins and failed logins, exports, bulk actions, permission changes, e-mails sent and lock-date changes, each with actor (user, API token or system), time and entity.

#### Scenario: Masked diff
- **WHEN** a user without the IBAN right reads the audit entry of an IBAN change
- **THEN** the before and after values are masked

#### Scenario: Token writes attributed
- **WHEN** an API token updates a member
- **THEN** the audit event names the token

### Requirement: Append-only audit log with retention
The system SHALL keep audit rows append-only for every role including admins, and purge them by a job according to retention per event class (defaults: login events 12 months, data changes 6 years, finance-related 10 years).

#### Scenario: Admin cannot edit audit rows
- **WHEN** any user or the application role tries to update or delete an audit row
- **THEN** the database refuses

#### Scenario: Retention purge
- **WHEN** the purge job runs
- **THEN** login events older than 12 months are removed and finance-related events younger than 10 years stay

### Requirement: Audit log search and export
The system SHALL let authorised users filter the audit log by module, user, entity and date, search entity labels in full text, view entries per record as a timeline, and export results as CSV, XLSX or PDF.

#### Scenario: Filter by entity
- **WHEN** an admin filters the audit log by one member and a date range
- **THEN** only events about that member in that range are shown and can be exported
