## ADDED Requirements

### Requirement: Deleting a club on a managed installation
The system SHALL let the operator delete a club with all its data only after the club's host name is confirmed, and SHALL leave every other club's data unchanged.

#### Scenario: Club leaves
- **WHEN** the operator deletes a club with its host name confirmed
- **THEN** no row of that club remains, the other clubs' invoices, journal and log are unchanged, and the host name signs nobody in

#### Scenario: Wrong confirmation
- **WHEN** the confirmation does not match the club's host name
- **THEN** nothing is deleted
