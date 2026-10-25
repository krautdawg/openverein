## ADDED Requirements

### Requirement: Portal settings
The system SHALL give a member a portal function only if one of their current groups allows it and none denies it, falling back to the club setting, and SHALL refuse requests for functions that are off.

#### Scenario: Resignation off, allowed by a group
- **WHEN** the club switches resignation off and the member is in a group that allows it
- **THEN** the member can resign in the portal

#### Scenario: Bank change denied by a group
- **WHEN** a member's group denies bank changes
- **THEN** an IBAN change request from the portal is refused with 403
