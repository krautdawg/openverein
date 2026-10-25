# banking Specification

## Purpose
TBD - created by archiving change bank-bulk-booking. Update Purpose after archive.
## Requirements
### Requirement: Booking movements without invoice
The system SHALL book several selected open bank movements of one direction to one ledger account in one step, one journal entry each, and SHALL undo such a booking only by a reversal.

#### Scenario: Two bank fees
- **WHEN** two open debits are booked to an expense account with sphere "Vermögensverwaltung"
- **THEN** two journal entries exist and both movements show "Gebucht" with their entry number

#### Scenario: Mixed directions
- **WHEN** an income and an expense movement are selected together
- **THEN** the booking is refused

