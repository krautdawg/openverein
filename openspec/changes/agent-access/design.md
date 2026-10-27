## Context

Reference: the KI Klub Klubraum (`server/klub/{tokens,auth,agent-limit,mcp,mcp-tools,oauth,openapi}.ts`, plan in `docs/klubraum-agent-plan.md`). It has the same goal on a smaller app.

OpenVerein differs from it in three ways:
- It already resolves every request to an `Actor` with role grants (`actorFromRequest`), and every route checks `requirePermission`, `requireClubWide` and friends.
- Members use a separate portal (`portalUser`, keyed by club and e-mail).
- The OpenAPI document is generated from the route schemas.

## Decisions

1. **One path for people and agents.** A token never gets its own routes. An admin token resolves to an `Actor` exactly like a session, and a member token resolves to the same value `portalUser` builds from a portal cookie. The MCP server calls the routes through `app.inject`, so even it has no route logic of its own.
2. **Tokens narrow and never widen.**
   - An admin token's effective permission per module is the minimum of the user's current grants and the token's cap. Group scopes and restricted fields come from the grants. The token is dead once the user is locked or loses the role.
   - Step-up routes (`requireStepUp`) stay closed to tokens, as for API keys today: money exports and the like need a person with TOTP.
   - A member token sees the portal switches like the cookie and is limited to GET when it is read-only.
3. **Tables.**
   - `personal_token`: `id`, `organization_id`, `kind` (`admin` | `member`), `user_id` (admin), `email` (member, lower-case), `name`, `prefix`, `token_hash`, `cap` (jsonb module → level, admin; null = all of the user's), `access` (`read` | `write`), `audience` (null | `mcp`), `oauth_client` (fingerprint), `expires_at`, `last_used_at`, `revoked_at` and `created_at`.
   - `agent_call`: `token_id` (FK, on delete cascade), `at`, `operation` (method + route pattern), `channel` (`rest` | `mcp` | `cli`) and `status`. It has no IP, IDs, body or query and is pruned after 90 days by the existing hourly job.
   - Erasure of a person deletes their member tokens; their log entries go with them through the cascade.
4. **Prefixes.**
   - `ov_` stays the club API key.
   - `ov_pat_` is an admin personal token and `ov_mpt_` a member token.
   - `ov_oat_` is an OAuth grant (audience `mcp`). An old app version rejects it, so a rollback never turns an MCP-only grant into a REST token.
5. **Operation IDs.** An `onRoute` hook sets `schema.operationId` from the method and the route pattern (`GET /members/:id` → `getMembersById`) unless the route sets one itself. A test fails if two routes get the same ID, and a snapshot test pins the IDs, so renaming a route is a visible API change.
6. **Limit.** An in-memory counter per token (fail-closed when full), the same algorithm as the Klubraum. It is deliberately approximate: per process, reset on deploy. The outer `/mcp` request is limited but not logged; the inner call is logged but not limited again, marked by a process secret header.
7. **MCP tools.**
   - Admin tokens get tools for `/api/v1` operations that are not hidden.
   - Member tokens get the `/portal/*` operations.
   - Uploads (octet-stream) and binary downloads larger than 5 MB are not offered over MCP; they are available through REST and the CLI.
8. **OAuth consent.**
   - An admin access consents in the web app (`/verbinden`), after its normal login (TOTP included). A member consents in the portal (`/portal/verbinden`), after the code login.
   - A new consent from the same client (same name and redirect URIs) replaces the old grant.
   - Errors before the redirect URI is validated are shown as a page, never redirected.

9. **Many operations, few tools.** A full admin reaches about 300 operations, which comes to roughly 250 kB of schemas in `tools/list`, too much for an agent's context. Up to 60 visible operations (members always), every operation is its own tool. Above that, the token gets three tools: `operationen_suchen`, `operation_beschreiben` and `operation_aufrufen`. They work from the same operation list and permission filter and run the same route.

## Risks

- Generated operation IDs change when a path changes. The snapshot test makes such a change explicit.
- An in-memory limit is not shared across instances. It is acceptable at club scale and documented.
