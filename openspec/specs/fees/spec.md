# fees Specification

## Purpose
TBD - created by archiving change fee-schedule. Update Purpose after archive.
## Requirements
### Requirement: Scheduled fee-run preview
The system SHALL create at most one fee-run preview per month on the scheduled day, with the rights of the person who set up the schedule, and SHALL never post it without a confirmation.

#### Scenario: Monthly preview
- **WHEN** the schedule is set to day 1 and the scheduler runs twice in the same month
- **THEN** exactly one preview run exists and no invoice has been posted

