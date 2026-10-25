# portal Specification

## Purpose
TBD - created by archiving change portal-settings. Update Purpose after archive.
## Requirements
### Requirement: Portal settings
The system SHALL give a member a portal function only if one of their current groups allows it and none denies it, falling back to the club setting, and SHALL refuse requests for functions that are off.

#### Scenario: Resignation off, allowed by a group
- **WHEN** the club switches resignation off and the member is in a group that allows it
- **THEN** the member can resign in the portal

#### Scenario: Bank change denied by a group
- **WHEN** a member's group denies bank changes
- **THEN** an IBAN change request from the portal is refused with 403

### Requirement: Own donation receipts in the portal
The system SHALL show members the donation receipts issued to their own person and provide the stored PDF of valid receipts only.

#### Scenario: Cancelled receipt
- **WHEN** a receipt is cancelled
- **THEN** the portal lists it as cancelled and refuses its PDF

