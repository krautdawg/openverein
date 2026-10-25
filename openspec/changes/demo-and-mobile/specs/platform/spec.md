## ADDED Requirements

### Requirement: Public demo safety
The system SHALL, in demo mode, refuse changes to user accounts, roles, API keys, file uploads and mail-server settings, and SHALL deliver no e-mail outside the server.

#### Scenario: Visitor tries to lock others out
- **WHEN** a visitor on the public demo tries to create a user or an API key
- **THEN** the request is refused with a notice that this is locked in the demo
