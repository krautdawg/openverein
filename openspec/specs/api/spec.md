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

### Requirement: Failed attempts free the idempotency key
The system SHALL store only successful responses under an idempotency key and SHALL let a request that failed be repeated with the same key.

#### Scenario: Retry after a validation error
- **WHEN** an invoice request with key K fails validation and is sent again, corrected, with key K
- **THEN** the invoice is created

### Requirement: Stale member edits are refused
The system SHALL refuse a member change with 412 when the request carries an If-Match version that no longer matches the stored record.

#### Scenario: Two editors
- **WHEN** one admin saves a member and a second admin then saves a change based on the version read before
- **THEN** the second change is refused with 412 and the record keeps the first change

### Requirement: Signed webhooks from an outbox
The system SHALL queue a webhook delivery in the same transaction as every audited change of a subscribed topic, post it with an HMAC signature, and retry failed deliveries with backoff.

#### Scenario: Receiver down
- **WHEN** the receiver answers 500 to a member.created delivery
- **THEN** the delivery stays queued with the attempt counted, and the next attempt after the backoff is signed and marked delivered on 2xx

### Requirement: Personal access tokens for admin accesses
The system SHALL let a signed-in admin access create personal tokens after a step-up. A token acts as that access with its current role grants, narrowed to the token's level (read, or read and write) and optional module list. It SHALL stop working when the access is locked, and SHALL never pass a step-up check.

#### Scenario: Token follows the role
- **WHEN** a treasurer's personal token is used after the treasurer lost the ledger right
- **THEN** ledger routes answer 403 for that token

#### Scenario: Read-only token
- **WHEN** a read-only personal token calls a POST route the access itself may call
- **THEN** the call is refused with 403

### Requirement: Personal access tokens for members
The system SHALL let a member signed in to the portal create tokens that act as that portal sign-in (same club, same address, same portal switches). A read-only token SHALL be limited to GET.

#### Scenario: Member agent reads own invoices
- **WHEN** a member token calls `GET /api/v1/portal/invoices`
- **THEN** it gets exactly the invoices the portal shows that member

#### Scenario: Member token at an admin route
- **WHEN** a member token calls `GET /api/v1/members`
- **THEN** the call is refused with 401

### Requirement: Agent call log for the owner
The system SHALL log every call made with a personal token (operation as method and route pattern, channel, status, time; no body, query, identifiers or IP), show the owner the last calls per token, and delete entries after 90 days.

#### Scenario: Owner sees the calls
- **WHEN** a member's agent read their invoices twice
- **THEN** the member's agent page lists two calls of `GET /portal/invoices` with status 200

### Requirement: Per-token rate limit
The system SHALL limit each personal token to 120 calls per minute and 2000 per hour and answer above that with 429 and `Retry-After`.

#### Scenario: Burst
- **WHEN** a token makes its 121st call within a minute
- **THEN** the call gets 429 with `Retry-After`

### Requirement: Stable operation IDs
The system SHALL give every documented operation a unique, stable `operationId`.

#### Scenario: Unique IDs
- **WHEN** the OpenAPI document is generated
- **THEN** no two operations share an `operationId`

### Requirement: Remote MCP server
The system SHALL serve a stateless MCP server at `/mcp` (Streamable HTTP, POST only) whose tools are the API operations the caller's token may call. A tool call SHALL be executed as a call of the same API route with the same token.

#### Scenario: Tool equals REST
- **WHEN** an agent calls the MCP tool for `GET /members`
- **THEN** the tool result contains the same data the REST call returns for that token

#### Scenario: Tool list follows rights
- **WHEN** a member token lists the tools
- **THEN** only portal operations are listed

### Requirement: Command-line client
The system SHALL serve a dependency-free CLI at `/ov.mjs` that calls any operation by its `operationId` with a token from `OV_TOKEN`.

#### Scenario: CLI call
- **WHEN** `OV_TOKEN=… node ov.mjs getPortalInvoices` runs against the instance
- **THEN** it prints the JSON answer of that operation

### Requirement: OAuth 2.1 for MCP clients
The system SHALL let MCP clients connect through OAuth 2.1 with dynamic client registration, PKCE S256, a consent page for the signed-in person and single-use authorization codes. The resulting token SHALL be valid only at `/mcp`.

#### Scenario: Code used twice
- **WHEN** a client redeems the same authorization code a second time
- **THEN** the token endpoint answers `invalid_grant`

#### Scenario: OAuth token at REST
- **WHEN** an OAuth-issued token calls `/api/v1/members` directly
- **THEN** the call is refused with 401

