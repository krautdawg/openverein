## ADDED Requirements

### Requirement: Wrong data key stops the server
The system SHALL refuse to start when DATA_KEY differs from the key the database was first started with.

#### Scenario: Restore on a new server with a fresh key
- **WHEN** a backup is restored on a server whose deploy/.env has a newly generated DATA_KEY
- **THEN** the app does not start and says that DATA_KEY does not match this database
