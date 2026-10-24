## ADDED Requirements

### Requirement: Invitations by single-use link
The system SHALL create new users without a password and return a single-use invitation token valid for 7 days, stored only as a hash; accepting it sets the password and signs the user in; a used or expired token SHALL be rejected; an admin can issue a new link, which invalidates the old one.

#### Scenario: Link used twice
- **WHEN** an invitation link is used a second time
- **THEN** the system rejects it and the password stays unchanged

### Requirement: At least one admin remains
The system SHALL refuse any change that would leave the organisation without an active user holding the unscoped built-in Admin role, and SHALL refuse users disabling their own account.

#### Scenario: Last admin demoted
- **WHEN** the only admin changes their own role to Treasurer
- **THEN** the request is refused with a problem document and nothing changes
