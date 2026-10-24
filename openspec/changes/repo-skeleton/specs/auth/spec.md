## ADDED Requirements

### Requirement: First-run setup
The system SHALL let the first visitor of an empty installation create the club (organisation name) and the first admin account (name, e-mail, password of at least 12 characters) in one step, sign them in, and refuse any further setup once an organisation exists.

#### Scenario: Setup creates club and admin
- **WHEN** a visitor submits the setup form on an empty installation
- **THEN** the organisation and an active admin account exist, the visitor is signed in and an audit event `organization.setup` is written

#### Scenario: Setup only once
- **WHEN** anyone calls the setup endpoint after an organisation exists
- **THEN** the API answers 409 with a problem document and nothing is created
