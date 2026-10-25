## ADDED Requirements

### Requirement: One command to back up and restore
The system SHALL provide `ovctl backup` and `ovctl restore`, where restore verifies the backup's checksums, first backs up the current state, and keeps erasures made after the backup.

#### Scenario: Restore an older backup
- **WHEN** an operator restores a backup taken before a member was added
- **THEN** the member is gone, the erasure log still holds the newer entries, and the server answers its health check
