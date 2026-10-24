## Why

OpenVerein needs a working foundation before any club feature can ship: a repository others can run in one command, CI that guards every pull request, a way to sign in, and an app shell with a design system that every later slice extends.

## What Changes

- Single TypeScript package: Fastify REST API with OpenAPI 3.1 at `/api/v1/openapi.json` and docs at `/api/docs`, React 19 + Vite web app served by the same process, PostgreSQL 18 with forward-only SQL migrations.
- First-run setup: create the club and the first admin account once; afterwards the endpoint refuses.
- Password login with argon2id, hashed server-side sessions in an HttpOnly cookie, 8-hour idle timeout, progressive lockout, rate limit on auth routes.
- Append-only audit log (database trigger) written in the same transaction as each change.
- RFC 9457 problem details for every error, German titles.
- App shell: hall-blue side rail, command palette (Ctrl/Cmd+K), side sheet and inline-edit components, demo banner, self-ticking first-run checklist; settings page with inline-editable club name.
- Local dev with `npm run dev` (Postgres + Mailpit in Docker), Dockerfile, GitHub Actions CI (typecheck, lint, unit/integration tests, Playwright e2e, OpenSpec validation).

## Capabilities

### New Capabilities

None. Baseline specs for all capabilities are in `openspec/specs/`.

### Modified Capabilities

- `auth`: adds the first-run setup requirement.
- `platform`: adds the command palette and the side-sheet/inline-edit interaction rule.

## Impact

New repository. Dependencies: fastify, fastify-type-provider-zod, zod, @fastify/{cookie,rate-limit,static,swagger,swagger-ui}, kysely, pg, @node-rs/argon2, react, react-router, @tanstack/react-query, lucide-react, self-hosted fonts (Source Sans 3, Barlow Semi Condensed). Deviations from Deliverable A are recorded in `docs/adr/0001-stack.md`.
