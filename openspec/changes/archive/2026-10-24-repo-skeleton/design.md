## Context

Deliverable A proposes NestJS, Better Auth, pg-boss, RLS and a separate worker. For a first release with one organisation per install, most of that is not needed yet. The owner's rule is the least code that fully works.

## Goals / Non-Goals

**Goals:** one-command local dev; every UI action goes through the public REST API; safe auth defaults; a design system later slices only extend.

**Non-Goals:** multi-tenancy and RLS, TOTP, e-mail codes, API tokens, background jobs (added by the slices that need them).

## Decisions

- **Fastify + zod type provider instead of NestJS.** Route schemas are zod; the same schemas generate OpenAPI and validate input, and `src/shared` reuses them in the web app. NestJS adds DI and decorators we do not need yet.
- **Own session auth instead of Better Auth (for now).** Argon2id hashes, 256-bit random session tokens stored as SHA-256, HttpOnly SameSite=Lax cookie. About 150 lines that we fully control. Better Auth stays an option when TOTP, passkeys and OIDC arrive.
- **Node 24 type stripping in production.** The server runs `.ts` files directly (`erasableSyntaxOnly`); no server build step.
- **Plain SQL migrations with an advisory lock**, applied on start and by `npm run migrate`.
- **Plain CSS with tokens** instead of a utility framework: one tokens file, one component stylesheet.
- **CSRF:** cookies are SameSite=Lax, every write must be `application/json` (enforced centrally, 415 otherwise) and a present `Origin` header must match the host.

## Risks / Trade-offs

- [Own auth code] → small surface, covered by integration tests (lockout, enumeration timing, logout); revisit with Better Auth when TOTP lands.
- [No RLS yet] → single organisation per install; every query still filters by `organization_id`. RLS comes with managed multi-tenant hosting.
- [Type stripping forbids enums and parameter properties] → enforced by `erasableSyntaxOnly`.
