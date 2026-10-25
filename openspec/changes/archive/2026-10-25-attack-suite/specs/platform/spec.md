## ADDED Requirements

### Requirement: Permission attack suite in CI
The system SHALL run, in CI, a test that calls every API route as restricted roles with out-of-scope ids and fails if any response contains out-of-scope personal data or a restricted IBAN, or if any write succeeds.

#### Scenario: New route without a scope check
- **WHEN** a new GET route returns a member by id without the division scope check
- **THEN** the attack suite fails and names the route
