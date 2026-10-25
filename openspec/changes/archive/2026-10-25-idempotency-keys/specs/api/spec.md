## ADDED Requirements

### Requirement: Failed attempts free the idempotency key
The system SHALL store only successful responses under an idempotency key and SHALL let a request that failed be repeated with the same key.

#### Scenario: Retry after a validation error
- **WHEN** an invoice request with key K fails validation and is sent again, corrected, with key K
- **THEN** the invoice is created
