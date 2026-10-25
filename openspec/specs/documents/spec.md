# documents Specification

## Purpose
The documents capability covers the content-addressed file store that every module uses for uploads and generated documents (MVP, from the technical notes of B M07, M12, M14, M17, M22 and M36), and the file manager with folder permissions, versioning and portal sharing (B P24, post-MVP). Items that B rates "should" or "could" are marked as such in the requirement name.
## Requirements
### Requirement: Content-addressed file store
The system SHALL store every file by its SHA-256 with size, MIME type, original name, owner, retention class and legal-hold flag, store identical bytes only once, and support a local volume by default with an optional S3-compatible backend.

#### Scenario: Deduplicated bytes
- **WHEN** the same PDF is uploaded as a receipt twice
- **THEN** the bytes are stored once and both file records point to the same hash

### Requirement: Immutable issued documents
The system SHALL store issued documents (invoices, cancellation documents, donation receipts, SEPA files, e-invoices) once with their SHA-256 and SHALL never re-render or overwrite them; every download SHALL return the stored bytes.

#### Scenario: Integrity check
- **WHEN** a stored issued document is read back
- **THEN** its SHA-256 equals the hash recorded at issue, otherwise the read fails with an integrity error

### Requirement: Retention classes and legal hold on files
The system SHALL give each file a retention class (for example `voucher` for 8 years, `temporary` for exports, `raw_banking`), delete temporary export files after 7 days, and never delete a file under legal hold or within its retention period.

#### Scenario: Temporary export expires
- **WHEN** an export file is 8 days old
- **THEN** it has been deleted and its download link answers "expired"

#### Scenario: Voucher kept
- **WHEN** deletion of a receipt file within its 8-year retention is requested
- **THEN** the system refuses

### Requirement: Encrypted raw banking files
The system SHALL encrypt files of class `raw_banking` (stored pain.008, pain.001 and CAMT files) and importer payloads at rest.

#### Scenario: Encrypted at rest
- **WHEN** a stored CAMT file is read directly from the volume
- **THEN** its content is ciphertext

### Requirement: Delete after commit
The system SHALL remove file bytes from storage only after the database transaction that dropped the last reference has committed.

#### Scenario: Rolled-back erasure
- **WHEN** an anonymisation transaction fails and rolls back
- **THEN** all files it referenced are still readable

### Requirement: Folders with permissions
The system SHALL offer folders for shared documents (for example statutes, minutes, forms) with read or write access granted per role or group, inherited by subfolders unless overridden, enforced through the same policy checks as the rest of the application; this is post-MVP (B P24).

#### Scenario: Folder access denied
- **WHEN** a member without access to folder "Vorstand" lists files
- **THEN** that folder and its files are not shown

#### Scenario: Inherited access
- **WHEN** group "Trainer" has read on "Formulare"
- **THEN** its members can read files in "Formulare/Anträge" unless that subfolder overrides it

### Requirement: File versioning
The system SHALL keep earlier versions when a file in a folder is replaced, and let authorised users list and download them; this is post-MVP (B P24).

#### Scenario: Previous version
- **WHEN** the statutes PDF is replaced by a new version
- **THEN** the previous version stays downloadable from the version list

### Requirement: Sharing to the portal
The system SHALL share folders or files to members in the portal by group, and shared files SHALL appear under "my documents"; this is post-MVP (B P24).

#### Scenario: Shared to members
- **WHEN** the board shares the minutes folder with all active members
- **THEN** every active member sees the files under "my documents" in the portal

### Requirement: Files on a member record
The system SHALL keep files attached to a member (for example a signed application) under the member's permissions, so only users who may read that member can list or download them.

#### Scenario: Trainer outside the group
- **WHEN** a trainer scoped to "Tennis" lists files of a member who is not in "Tennis"
- **THEN** the request fails as not found

### Requirement: Raw byte upload
The system SHALL accept uploads as `application/octet-stream` of at most 20 MB on the file routes only, with name, place and retention class as query parameters.

#### Scenario: Upload elsewhere refused
- **WHEN** a client posts `application/octet-stream` to the members route
- **THEN** the request is refused with 415

### Requirement: Inventory and lending
The system SHALL track the club's items and their loans to members, never lending more than available and marking loans past their due date.

#### Scenario: Last ball
- **WHEN** 2 of 3 balls are lent and someone asks for 2 more
- **THEN** the loan is refused with "Nur noch 1 Stück verfügbar"

