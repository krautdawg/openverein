## ADDED Requirements

### Requirement: ICS import
The system SHALL import events from an ICS file into a calendar the user may write to, in the club's time zone, and SHALL not import an event with the same UID twice into the same calendar.

#### Scenario: Same file twice
- **WHEN** the same ICS file with two events is imported twice
- **THEN** the second import adds nothing and reports two duplicates
