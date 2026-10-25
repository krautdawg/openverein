## ADDED Requirements

### Requirement: Erasure replay at start-up
The system SHALL append each erasure (organisation id, person id, time) to a file beside the stored files and, at start-up before accepting requests, anonymise again every listed person that is present and not anonymised.

#### Scenario: Restored backup
- **WHEN** the database is restored from a backup taken before a person was anonymised and the server starts
- **THEN** the person is anonymised again before the first request is served
