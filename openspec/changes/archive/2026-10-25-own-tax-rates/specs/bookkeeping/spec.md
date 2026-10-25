## ADDED Requirements

### Requirement: Own tax rates
The system SHALL let the club add tax rates with validity and tax accounts, SHALL never change a rate's percentage, and SHALL refuse to end a rate before a booking made with it.

#### Scenario: Ending a used rate too early
- **WHEN** a rate was used on 01.03.2026 and its end is set to 28.02.2026
- **THEN** the change is refused
