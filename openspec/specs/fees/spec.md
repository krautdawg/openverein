# fees Specification

## Purpose
TBD - created by archiving change fee-schedule. Update Purpose after archive.
## Requirements
### Requirement: Scheduled fee-run preview
The system SHALL create at most one fee-run preview per month on the scheduled day, with the rights of the person who set up the schedule, and SHALL never post it without a confirmation.

#### Scenario: Monthly preview
- **WHEN** the schedule is set to day 1 and the scheduler runs twice in the same month
- **THEN** exactly one preview run exists and no invoice has been posted

### Requirement: Age brackets
The system SHALL bill the amount of the first age bracket that the member's age at the start of a period fits, else the version's amount, and an individual amount SHALL take precedence.

#### Scenario: 18th birthday in March, monthly fee
- **WHEN** a member born on 15.03.2008 is billed monthly from January 2026 with a bracket up to 17 years
- **THEN** January to March use the bracket amount and April the adult amount

