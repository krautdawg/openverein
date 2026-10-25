## ADDED Requirements

### Requirement: Stale member edits are refused
The system SHALL refuse a member change with 412 when the request carries an If-Match version that no longer matches the stored record.

#### Scenario: Two editors
- **WHEN** one admin saves a member and a second admin then saves a change based on the version read before
- **THEN** the second change is refused with 412 and the record keeps the first change
