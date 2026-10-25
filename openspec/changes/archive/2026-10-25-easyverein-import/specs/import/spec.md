## ADDED Requirements

### Requirement: Status from join and exit dates
The system SHALL set the status of imported members from their join and exit dates: future join date → `future`, exit date in the past → `former`, exit date in the future → `resigned`, otherwise `active`.

#### Scenario: Former member
- **WHEN** a row has an exit date of 31.12.2023
- **THEN** the member is imported as `former` with that exit date and closed group memberships
