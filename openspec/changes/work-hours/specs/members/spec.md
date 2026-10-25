## ADDED Requirements

### Requirement: Work hours and substitute fee
The system SHALL track logged work hours per member and year against a club rule and create one substitute-fee draft invoice per member and year for missing hours.

#### Scenario: Missing hours
- **WHEN** the rule asks 10 hours at 15 € and a member logged 7.5 hours
- **THEN** the overview shows 2.5 hours open and 37,50 €, and settling creates one draft invoice of 37,50 €; settling again creates none
