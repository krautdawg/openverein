## ADDED Requirements

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
