## ADDED Requirements

### Requirement: Files on a member record
The system SHALL keep files attached to a member (for example a signed application) under the member's permissions, so only users who may read that member can list or download them.

#### Scenario: Trainer outside the group
- **WHEN** a trainer scoped to "Tennis" lists files of a member who is not in "Tennis"
- **THEN** the request fails as not found

### Requirement: Raw byte upload
The system SHALL accept uploads as `application/octet-stream` of at most 20 MB on the file routes only, with name, place and retention class as query parameters.

#### Scenario: Upload elsewhere refused
- **WHEN** a client posts `application/octet-stream` to the members route
- **THEN** the request is refused with 415
