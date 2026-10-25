## ADDED Requirements

### Requirement: Long operations run as jobs
The system SHALL run long operations (starting with the full export) as background jobs that return at once, report progress, survive a closed tab, and run with the starting user's current permissions.

#### Scenario: Export as a job
- **WHEN** an admin starts a full export
- **THEN** the API answers 202 with a queued job, the worker builds the export, and the job ends as done with the export file

#### Scenario: Permission revoked before the job runs
- **WHEN** the admin role is removed from the starting user before the worker picks up the job
- **THEN** the job fails with a message that the permission is missing, and no export is created

#### Scenario: One at a time
- **WHEN** a full export job is queued or running and another is started
- **THEN** the second request is refused with 409
