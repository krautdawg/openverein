## ADDED Requirements

### Requirement: Bulk actions over all filter results
The system SHALL let a user select all members matching the current filter, confirm a bulk action after seeing the count and five sample names, and run actions over more than 100 members as a background job with a per-record result.

#### Scenario: Large selection
- **WHEN** an admin adds 101 filtered members to a group
- **THEN** the API answers 202 with a job, and the finished job reports 101 succeeded and none skipped
