## 1. Personal tokens, call log, limit (slice 1)

- [x] 1.1 Migration: `personal_token`, `agent_call`
- [x] 1.2 Stable `operationId` for every route (onRoute hook), uniqueness and snapshot test
- [x] 1.3 Admin personal tokens: create (step-up), list with recent calls, revoke; actor = user grants capped by token
- [x] 1.4 Member tokens: create, list, revoke in the portal; `portalUser` accepts them; read-only tokens are GET-only
- [x] 1.5 Call log (best effort, on response) and per-token limit (120/min, 2000/h, 429 with Retry-After)
- [x] 1.6 Pruning (90 days) in the hourly job; erasure removes member tokens
- [x] 1.7 Web: "Agenten" page in settings and in the portal, with the one-time token display, connected agents, last calls and revoke; screenshots at 390/768/1280
- [x] 1.8 Tests: narrowing (cap, read-only, locked user, lost role, step-up closed), member token portal parity, limit at its edge, log entries, revoked/expired

## 2. MCP (slice 2)

- [x] 2.1 `/mcp` POST-only, 64 kB body, stateless SDK server per request
- [x] 2.2 Tools generated from the OpenAPI document, filtered by the token's rights; executed via `app.inject` with the caller's token
- [x] 2.3 Errors as `isError` tool results with the problem text; PDF downloads up to 5 MB as embedded resources
- [x] 2.4 Tests: tool result equals the REST answer, tool list follows rights, member vs admin tools, limit counted once, log written once

## 3. CLI (slice 3)

- [x] 3.1 `ov.mjs` served at `/ov.mjs`: `ov list`, `ov <operationId> [path params] [--query v] [--json …|@file]`
- [x] 3.2 Channel marker `X-OV-Channel: cli` (self-declared, metadata only)
- [x] 3.3 Test: the CLI runs against a test server

## 4. OAuth 2.1 (slice 4)

- [x] 4.1 Metadata (RFC 9728 for `/mcp`, RFC 8414), `WWW-Authenticate` on every 401 from `/mcp`
- [x] 4.2 Stateless DCR (signed client_id), authorize with PKCE S256 and `resource`, token endpoint, nonce table for single use
- [x] 4.3 Consent pages in the web app and portal; replacing a grant from the same client
- [x] 4.4 Tests: tampering, redirect mismatch, PKCE, double and parallel redemption, audience, replacement, step-up (the full flow runs in tests/agentOAuth.test.ts)
