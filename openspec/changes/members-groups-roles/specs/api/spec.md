## ADDED Requirements

### Requirement: Tokens cannot mint tokens
The system SHALL only let signed-in users (not API tokens) create API tokens, so a leaked key cannot create further keys.

#### Scenario: Token tries to create a token
- **WHEN** a request authenticated with an API token calls `POST /api/v1/api-tokens`
- **THEN** the API answers 403 naming the missing permission
