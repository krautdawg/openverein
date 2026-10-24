# api Specification

## Purpose
The api capability covers the documented REST API with OpenAPI 3.1 and scoped API tokens (B M34), plus the cross-cutting rule that every action a human can take in the UI is also possible over the same public REST API, with RFC 9457 errors, cursor pagination and idempotency keys on money writes. Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.
## Requirements
### Requirement: API parity with the UI
The system SHALL expose every action available to a human user as a documented endpoint under `/api/v1`, and the web UI and portal SHALL use only these public endpoints, so that the API is complete by construction.

#### Scenario: No private endpoints
- **WHEN** the CI route check compares UI network calls with the OpenAPI document
- **THEN** it fails on any call to an endpoint that is not documented

### Requirement: OpenAPI document and docs
The system SHALL generate an OpenAPI 3.1 document from the code at `/api/v1/openapi.json` and serve rendered reference docs at `/api/docs` without login.

#### Scenario: Public docs
- **WHEN** an anonymous visitor opens `/api/docs`
- **THEN** the rendered API reference is shown

### Requirement: Representation conventions
The system SHALL use JSON with `snake_case` fields, ISO 8601 dates, and amounts as integer cents with `currency: "EUR"`.

#### Scenario: Money as cents
- **WHEN** an invoice of EUR 120.50 is read
- **THEN** the amount is returned as `12050` with `currency: "EUR"`

### Requirement: Cursor pagination and change filter
The system SHALL paginate every collection with an opaque cursor (`?cursor=&limit=`, limit at most 200) and accept an `updated_since` filter on every collection.

#### Scenario: Limit capped
- **WHEN** a client requests `limit=500`
- **THEN** at most 200 items are returned with a cursor to the next page

#### Scenario: Incremental sync
- **WHEN** a client lists members with `updated_since=2026-10-01T00:00:00Z`
- **THEN** only members changed since then are returned

### Requirement: RFC 9457 problem details
The system SHALL return every error as an RFC 9457 problem document with a stable `type` URI, a German or English `title` by request language, and for validation errors the failing fields.

#### Scenario: Validation error
- **WHEN** a member is created with an invalid e-mail
- **THEN** the response is 400 or 422 with `application/problem+json` naming the field

### Requirement: Idempotency keys on money writes
The system SHALL require an `Idempotency-Key` header on every POST that creates money objects (invoices, fee-run posting, collection runs, allocations, donation receipts), store key and response for 24 hours, and return the stored response for a repeated key instead of acting twice.

#### Scenario: Retry after timeout
- **WHEN** a client repeats a fee-run post with the same idempotency key
- **THEN** the original response is returned and no second set of invoices is created

#### Scenario: Missing key
- **WHEN** an invoice is created without an `Idempotency-Key` header
- **THEN** the request is rejected with a problem document

### Requirement: Optimistic concurrency
The system SHALL return an `ETag` on resources and require `If-Match` on PATCH, rejecting stale writes with 412.

#### Scenario: Concurrent edit
- **WHEN** two admins edit the same member and the second sends an outdated `If-Match`
- **THEN** the second write is rejected with 412

### Requirement: Long operations as jobs
The system SHALL answer long operations (fee runs, exports, imports, bulk actions, reports) with `202 Accepted` and a job resource whose progress is readable by `GET /jobs/{id}` and by server-sent events.

#### Scenario: Export job
- **WHEN** a client starts an export of 5,000 rows
- **THEN** it receives 202 with a job id and later a result file link

### Requirement: Scoped API tokens
The system SHALL let authorised users create API tokens with name, a role grant (any role, including scoped roles), optional expiry of at most one year, optional IP allow-list and last-used information; the token SHALL be shown once and stored only as a hash, and can be rotated and revoked; a token SHALL NOT hold finance write permission unless the issuing admin has TOTP enabled.

#### Scenario: Shown once
- **WHEN** a token is created
- **THEN** its secret is displayed once and later only its prefix is visible

#### Scenario: Revoked token
- **WHEN** a revoked token is used
- **THEN** the request is answered with 401

#### Scenario: Scoped token
- **WHEN** a token bound to Division lead for "Tennis" lists members
- **THEN** only members in the Tennis scope are returned

### Requirement: Rate limits
The system SHALL limit API use to 600 requests per minute per token by default, with tighter limits on authentication and public application endpoints, answering excess requests with 429 and a `Retry-After` header.

#### Scenario: Limit exceeded
- **WHEN** a token sends its 601st request within a minute
- **THEN** the response is 429 with `Retry-After`

### Requirement: API writes audited
The system SHALL audit-log every API write with the token name.

#### Scenario: Token write logged
- **WHEN** the website integration token creates a person
- **THEN** the audit log shows the creation with that token's name

### Requirement: Tokens cannot mint tokens
The system SHALL only let signed-in users (not API tokens) create API tokens, so a leaked key cannot create further keys.

#### Scenario: Token tries to create a token
- **WHEN** a request authenticated with an API token calls `POST /api/v1/api-tokens`
- **THEN** the API answers 403 naming the missing permission

