## Why

OpenVerein becomes the one backend for the web app and for agents (Tim, 2026-10-27; KI Klub Werder moves onto it later). A treasurer should be able to hand their work to Claude, ChatGPT or Claude Code, and a member should be able to let their own agent read invoices or answer an event invitation. The agent must get exactly what its person gets in the web app (admin) or portal (member), never more.

Today there are club API keys (a role, no person behind it). They have no call log the owner can see, no per-key rate limit and no MCP, CLI or OAuth.

## What Changes

The port follows the KI Klub Klubraum plan (`/home/tim/Documents/KI Klub Werder/Webseite/docs/klubraum-agent-plan.md`), adapted to OpenVerein's roles and portal. It ships in four slices:

1. **Personal access tokens, call log and limit.**
   - Admin accesses get personal tokens (`ov_pat_…`). Such a token acts as its user with the user's current grants, narrowed to the token's level (read only, or read and write) and optionally to some modules. Creating one needs a step-up.
   - Members get portal tokens (`ov_mpt_…`). Such a token acts as the portal sign-in for the token's club and address, with the portal's switches; read only, or read and write.
   - All tokens are stored as SHA-256 hashes, shown once, revocable, and expire after 30, 90 or 365 days. There are at most 10 active tokens per person.
   - Club API keys stay as they are.
   - Every token call is logged (operation pattern, channel, status; no body, IP or IDs) and shown to the token's owner. Entries are kept for 90 days.
   - Each token is limited to 120 calls per minute and 2000 per hour (429 with `Retry-After`).
   - Every route gets a stable `operationId` in the OpenAPI document.
2. **Remote MCP at `/mcp`.** Streamable HTTP, stateless, POST only. Each tool is one OpenAPI operation, generated from the document and executed as an in-process `app.inject` call with the caller's token. Authorisation, validation, idempotency, audit, log and limit therefore run once, on the same route the web app uses. `tools/list` shows only operations the token may call.
3. **CLI `ov`.** A single Node file without dependencies, served by the instance at `/ov.mjs`. It loads the OpenAPI document and calls any operation by `operationId`, with the token from `OV_TOKEN`.
4. **OAuth 2.1 for `/mcp`.**
   - RFC 9728 and RFC 8414 metadata, stateless DCR (RFC 7591), PKCE S256, `resource` (RFC 8707) and single-use codes (database nonce).
   - A consent page, in the web app for admin accesses and in the portal for members.
   - An OAuth grant is a personal token with audience `mcp`: it works only at `/mcp`.

## Capabilities

### Modified Capabilities

- `api`: personal tokens, call log, per-token limit, operation IDs, MCP, CLI and OAuth.

## Impact

- Migrations: personal and member tokens and the call log (slice 1); the OAuth code nonce (slice 4).
- New dependency `@modelcontextprotocol/sdk` (slice 2).
- New web pages: "Agenten" in the admin settings and in the portal.
- No change for existing API keys or sessions.
