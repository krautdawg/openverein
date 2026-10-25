## ADDED Requirements

### Requirement: Sensitive custom fields stay with club-wide readers
The system SHALL hide sensitive custom fields and their values from users whose member access is limited to groups, SHALL never offer them as mail placeholders, and SHALL record changes to them in the audit log without the values.

#### Scenario: Trainer opens a profile
- **WHEN** a trainer limited to the tennis group opens a member with an allergy noted in a sensitive field
- **THEN** neither the field nor its value is shown or returned by the API
