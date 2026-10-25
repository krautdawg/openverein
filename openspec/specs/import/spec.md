# import Specification

## Purpose
The import capability covers the full data export, CSV / XLSX import with column mapping and duplicate handling, and the easyVerein importer (B M37, M38, M39). For easyVerein, importing from easyVerein's CSV / XLSX exports is the first deliverable; pulling through the easyVerein API (v3, v2 fallback) follows later and reuses the same mapping, review and reconciliation. Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.
## Requirements
### Requirement: Full data export
The system SHALL export all organisation data as a ZIP with one JSON-lines and one CSV file per entity, a `files/` directory with the stored files and a `manifest.json` (schema version, counts, SHA-256 of each file, export time), following a documented, versioned export schema, from the UI and as `ovctl export-all`.

#### Scenario: Manifest hashes
- **WHEN** a full export is generated
- **THEN** every file in the ZIP has a matching SHA-256 in `manifest.json`

### Requirement: Full export access control
The system SHALL allow the full export only to users with the Admin role and a fresh TOTP, audit-log each run, and keep the file 7 days.

#### Scenario: Treasurer refused
- **WHEN** a treasurer without the Admin role starts a full export
- **THEN** the request is denied

### Requirement: Export round trip
The system SHALL restore the data when an export is imported into an empty instance, verified by a round-trip test in CI.

#### Scenario: Round trip
- **WHEN** CI exports a fixture organisation and imports it into an empty instance
- **THEN** a second export matches the first apart from export time

### Requirement: Spreadsheet import with mapping
The system SHALL import persons, members, group memberships with dates, mandates, open invoices, bank transactions and custom field values from CSV (with encoding and separator detection) or XLSX (with sheet choice), with a column-mapping UI that suggests targets from header names, saved mapping profiles, value mapping for selects and statuses (for example "aktiv" → `active`), and file size and row caps for untrusted uploads.

#### Scenario: Value mapping
- **WHEN** a column holds "aktiv" and "ausgetreten"
- **THEN** the admin maps them to `active` and `former` before import

### Requirement: Import dry run
The system SHALL run every import first as a dry run that lists rows to create, update and skip and errors per row with the reason, writing nothing until the admin confirms; validation SHALL use the same service rules as the UI.

#### Scenario: Nothing written
- **WHEN** a dry run reports 3 rows with invalid IBANs
- **THEN** no record is created until the admin confirms

### Requirement: Match keys and duplicates
The system SHALL let the admin choose the match key (member number, e-mail, or name plus date of birth) and send unmatched rows through duplicate scoring.

#### Scenario: Update by member number
- **WHEN** an imported row has an existing member number
- **THEN** the existing member is updated rather than duplicated

### Requirement: Import rollback
The system SHALL tag every created row with its import run, run imports as jobs, and allow rolling back a whole import while no dependent records exist.

#### Scenario: Rollback blocked
- **WHEN** an invoice was issued to a person created by an import
- **THEN** rolling back that import is refused and names the dependent record

### Requirement: easyVerein import from CSV exports
The system SHALL import an organisation from easyVerein's CSV / XLSX export files (members, contacts, groups, fees, mandates, invoices, bookings, custom fields) with presets for easyVerein's column layout, as the first easyVerein import path.

#### Scenario: Export folder import
- **WHEN** an admin uploads the set of easyVerein export files
- **THEN** the preset maps known columns and lists unknown columns for manual mapping

### Requirement: easyVerein API pull
The system SHALL, after the CSV path, pull data through easyVerein API v3 with v2 fallback per resource, using an organisation token (or user login with 2FA) stored encrypted and deleted after cut-over, respecting 100 requests per minute with back-off on 429 and token refresh after 15 days, storing raw JSON per record with source id and fetch time, downloading and hashing files, and supporting a delta pass by `updated_at` after the freeze.

#### Scenario: Rate limit respected
- **WHEN** easyVerein answers 429
- **THEN** the importer backs off and resumes without losing records

### Requirement: easyVerein mapping
The system SHALL map contacts to persons, members to members, `_relatedMember` chains to households, groups and assignments to groups and memberships, group fees to fee plans with one version from current values covering every easyVerein interval (one-off, 1–12, 24, 36, 60 months), the group start-date mode and first service period, active mandates with reference and date, invoices by kind, current-year bookings to transactions and entries with closed years archived as files, custom fields, open change requests and applications, and saved filters to saved views on a best-effort basis; credit balances SHALL be imported as one opening credit per person; number ranges SHALL continue from the highest imported number; members SHALL receive sign-in invitations because passwords cannot be exported.

#### Scenario: Number ranges continue
- **WHEN** the highest imported invoice number is `2026-0412`
- **THEN** the next issued invoice is `2026-0413`

#### Scenario: Mandate references kept
- **WHEN** mandates are imported
- **THEN** their references and the creditor ID are unchanged

### Requirement: Discrepancy review queue
The system SHALL dry-run the easyVerein import into a disposable schema, report discrepancies (unmapped fields, fee formulas, ambiguous families, mandates without date or reference, invoices without lines) into a review queue, and apply nothing until every flagged item is resolved or explicitly skipped, then apply in dependency order.

#### Scenario: Ambiguous family
- **WHEN** a `_relatedMember` chain has two possible payers
- **THEN** it is flagged and the import cannot be applied until it is resolved or skipped

### Requirement: No double billing or double receipting after migration
The system SHALL compute the last assessed period per fee assignment from the imported invoices so that the first fee run does not bill those periods again, and SHALL import easyVerein donation receipts as archived receipts linked to the donations they cover, blocking donations of a receipted period with unknown coverage from new receipts until reviewed.

#### Scenario: First fee run after import
- **WHEN** easyVerein already invoiced Q1 and the first OpenVerein fee run covers Q1
- **THEN** the preview creates nothing for Q1

#### Scenario: Receipted donation
- **WHEN** a donation is covered by an imported 2026 collective receipt
- **THEN** it cannot be put on a new receipt

### Requirement: Reconciliation report
The system SHALL produce a reconciliation report that blocks the scheduler and fee runs until signed off, covering member and mandate counts, unchanged creditor ID and mandate references, open-item total per member, credit balance per person, donation receipt coverage, invoice totals by type, bank balance at cut-over, current-year EÜR totals by account and sphere, highest document numbers, file count and hash manifest, plus a checklist of 20 member histories to verify by hand.

#### Scenario: Fee run blocked before sign-off
- **WHEN** a treasurer starts a fee run before the reconciliation report is signed off
- **THEN** the system refuses and links the report

### Requirement: Status from join and exit dates
The system SHALL set the status of imported members from their join and exit dates: future join date → `future`, exit date in the past → `former`, exit date in the future → `resigned`, otherwise `active`.

#### Scenario: Former member
- **WHEN** a row has an exit date of 31.12.2023
- **THEN** the member is imported as `former` with that exit date and closed group memberships

