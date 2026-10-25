## ADDED Requirements

### Requirement: Printed dunning letters
The system SHALL render a reminder letter for each selected open invoice and refuse when none is open any more.

#### Scenario: Invoice paid meanwhile
- **WHEN** dunning letters are requested only for an invoice that has been paid in full
- **THEN** the request is refused with 409 and no PDF is produced
