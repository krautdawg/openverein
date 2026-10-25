## ADDED Requirements

### Requirement: Attendance without connection
The system SHALL keep attendance marks made without a connection on the device and send them when the connection returns, without losing a mark silently.

#### Scenario: Hall without signal
- **WHEN** a trainer marks a member present while offline
- **THEN** the mark shows at once with a waiting notice, and it is stored on the server after the connection returns
