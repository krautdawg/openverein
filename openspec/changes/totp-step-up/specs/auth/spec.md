## ADDED Requirements

### Requirement: TOTP replay protection
The system SHALL accept each TOTP time step at most once per user, so an observed code cannot be reused.

#### Scenario: Same code twice
- **WHEN** a code was used to sign in and the same code is entered again within its 30 seconds
- **THEN** the second attempt is refused

### Requirement: Admin reset of a second factor
The system SHALL let an admin (with step-up) reset another user's second factor, end that user's sessions and write an audit event; users reset their own factor through setup.

#### Scenario: Lost phone
- **WHEN** an admin resets the second factor of a treasurer who lost their phone
- **THEN** the treasurer's sessions end and the next sign-in asks them to set up TOTP again
