## ADDED Requirements

### Requirement: Sign-in through the club's identity provider
The system SHALL sign in through the club's OIDC provider only accesses that exist and are active, matched by a verified e-mail address, and SHALL still require the second factor of accesses that have one.

#### Scenario: Unknown address
- **WHEN** the provider confirms an address that has no access in the club
- **THEN** no session is created and the sign-in page explains why

#### Scenario: Access with second factor
- **WHEN** an access with TOTP signs in through the provider
- **THEN** the sign-in continues with the code step
