# gdpr Specification

## Purpose
The gdpr capability covers consent records, retention classes, anonymisation that keeps the books intact, legal holds, the machine-readable data subject access export, coverage of raw stores, erasure that survives backup restores, and the DPO and DPIA checks in the first-run checklist (B M36). Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.

## Requirements
### Requirement: Consent records
The system SHALL record consents per person and purpose (for example newsletter, photos on the website) with granted and withdrawn timestamps, source (application form, portal, paper) and text version.

#### Scenario: Withdrawal
- **WHEN** a member withdraws newsletter consent in the portal
- **THEN** the withdrawal time and source are recorded and the member is excluded from newsletter mails

### Requirement: Retention classes
The system SHALL assign every record type a retention class with defaults from § 147 AO (books and records 10 years, vouchers 8 years, other listed documents 6 years) and mandates at least 14 months after the last collection, and show the legal basis of each default in the settings.

#### Scenario: Legal basis shown
- **WHEN** an admin opens retention settings
- **THEN** each class shows its period and legal basis

### Requirement: Retention review and erasure
The system SHALL list persons and records due for erasure for review and erase them on confirmation, or automatically when the organisation enables that setting.

#### Scenario: Review list
- **WHEN** the retention job runs
- **THEN** records past their retention appear in a review list and nothing is erased without confirmation unless automatic mode is on

### Requirement: Anonymisation
The system SHALL anonymise a person by erasing or replacing profile fields, contact data, custom fields and files while financial documents keep their identity snapshot until their own retention ends and the person row keeps an opaque id; anonymisation SHALL be blocked while open items or active mandates exist.

#### Scenario: Blocked by open item
- **WHEN** an admin anonymises a person with an open invoice
- **THEN** the system refuses and names the open item

#### Scenario: Invoice keeps snapshot
- **WHEN** a former member without open items is anonymised
- **THEN** the profile shows no personal data and their issued invoices still show the original name and address

### Requirement: Legal hold
The system SHALL let authorised users set a legal hold on a person or record, which blocks erasure and anonymisation until released.

#### Scenario: Hold blocks erasure
- **WHEN** a person under legal hold is due for erasure
- **THEN** the person is skipped and listed with the hold reason

### Requirement: Data subject access export
The system SHALL produce for one person a ZIP with machine-readable JSON and a human-readable PDF of all data about them, including consents, memberships, invoices, donations, mails sent and audit entries about them, run as a job that tracks the one-month deadline; the same data sheet SHALL be available as a bulk action.

#### Scenario: Complete export
- **WHEN** an admin starts an access export for a member
- **THEN** the ZIP contains JSON and PDF covering profile, consents, memberships, invoices, donations, deliveries and audit entries

### Requirement: Raw stores covered
The system SHALL include raw stores in the erasure registry: bank `raw` JSON and stored SEPA and CAMT files are encrypted and kept with voucher retention, and importer payloads are purged 90 days after the import sign-off.

#### Scenario: Importer payload purge
- **WHEN** 90 days have passed since the reconciliation sign-off
- **THEN** raw importer payloads are deleted while source and target ids remain

### Requirement: Erasure survives restore
The system SHALL write an erasure log entry with opaque ids only for every erasure, and `ovctl restore` SHALL replay the erasure log before the application starts, so that restoring an older backup does not bring erased persons back.

#### Scenario: Restore older backup
- **WHEN** a backup taken before a person's anonymisation is restored
- **THEN** the person is anonymised again before the application accepts requests

### Requirement: DPO and DPIA checks
The system SHALL warn in the first-run checklist when 15 or more users hold member read rights (DPO requirement under § 38 BDSG) and SHALL ask for a DPIA with a pre-filled template when custom fields are flagged as health data or members under 16 exist.

#### Scenario: DPO warning
- **WHEN** the 15th user with member read rights is created
- **THEN** the checklist shows the DPO warning

### Requirement: Only necessary cookies
The system SHALL set only strictly necessary cookies (session, CSRF, locale) and load no third-party resources, so that no consent banner is needed.

#### Scenario: Cookie inventory
- **WHEN** a visitor opens the public application form
- **THEN** no cookie other than the necessary ones is set
