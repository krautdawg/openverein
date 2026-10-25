## ADDED Requirements

### Requirement: Age brackets
The system SHALL bill the amount of the first age bracket that the member's age at the start of a period fits, else the version's amount, and an individual amount SHALL take precedence.

#### Scenario: 18th birthday in March, monthly fee
- **WHEN** a member born on 15.03.2008 is billed monthly from January 2026 with a bracket up to 17 years
- **THEN** January to March use the bracket amount and April the adult amount
