## ADDED Requirements

### Requirement: Inventory and lending
The system SHALL track the club's items and their loans to members, never lending more than available and marking loans past their due date.

#### Scenario: Last ball
- **WHEN** 2 of 3 balls are lent and someone asks for 2 more
- **THEN** the loan is refused with "Nur noch 1 Stück verfügbar"
