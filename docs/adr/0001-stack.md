# ADR 0001: Stack for the first release

Date: 2026-10-24. Status: accepted.

## Context

Deliverable A (`saaskiller/easyverein/deliverables/A-architecture-plan.md`, kept outside this repository) proposes Node 24, NestJS on Fastify, React 19 + Vite with TanStack Router/Query/Table, PostgreSQL 18 with Kysely, RLS, pg-boss, Better Auth, Typst, Caddy and an `ovctl` CLI. The owner asked for the simplest option wherever A over-engineers a first release.

## Decision

| Area | A says | We do | Why |
|---|---|---|---|
| Backend framework | NestJS on Fastify | Plain Fastify 5 with `fastify-type-provider-zod` | Zod schemas validate input, generate OpenAPI and are shared with the web app. No DI container needed. |
| Build | compiled TypeScript | Node 24 runs `.ts` directly (type stripping, `erasableSyntaxOnly`) | No server build step; Vite builds only the web app. |
| Auth | Better Auth | Own session auth (argon2id, hashed session tokens, HttpOnly cookie) | ~150 lines, fully tested. Reconsider Better Auth when TOTP, passkeys or OIDC are built. |
| Tenancy | `organization_id` + RLS | `organization_id` on every row, filtered in code, one organisation per install | RLS arrives with managed multi-tenant hosting (A, Phase 2). |
| Router | TanStack Router | React Router (declarative mode) | Fewer moving parts, no code generation. |
| Styling | not specified | Plain CSS with design tokens | One tokens file, one stylesheet; no utility framework. |
| Jobs | pg-boss + outbox | Added by the first slice that needs background work | Nothing in slice 0 runs in the background. |
| Proxy, ops | Caddy + `ovctl` | Docker image + Compose; TLS by the operator's proxy | `ovctl` is post-MVP operations work. |
| Mobile | PWA only (A excludes native apps) | Capacitor wrapper around the same web build, built by Codemagic | Owner's instruction; no native code beyond what Capacitor needs. |

Kept from A: PostgreSQL 18 (`uuidv7()`), Kysely with forward-only SQL migrations, REST + OpenAPI 3.1, RFC 9457 errors, integer cents, append-only audit log enforced by a trigger, German-first UI.

## Consequences

Later slices add dependencies only when a feature needs them, and record each deviation here or in a new ADR.
