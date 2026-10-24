## 1. Repository and tooling

- [x] 1.1 package.json, tsconfig (type stripping), ESLint, Vitest, Playwright
- [x] 1.2 docker-compose (Postgres 18, Mailpit), .env.example, Dockerfile
- [x] 1.3 GitHub Actions CI: typecheck, lint, tests, e2e, OpenSpec validate
- [x] 1.4 LICENSE (AGPL-3.0), README, ADR 0001, docs/decisions.md

## 2. Server

- [x] 2.1 Migration runner and 0001_init.sql (organization, app_user, session, append-only audit_event)
- [x] 2.2 Fastify app with zod schemas, OpenAPI document and docs, RFC 9457 errors, rate limit
- [x] 2.3 Setup, login, logout, me; progressive lockout; audit events
- [x] 2.4 Organisation read and update

## 3. Web

- [x] 3.1 Design tokens and component styles
- [x] 3.2 Shell with side rail, mobile drawer, demo banner, command palette
- [x] 3.3 Setup, login, overview with checklist, settings with inline edit

## 4. Verification

- [x] 4.1 Integration tests for setup, login, lockout, logout, audit immutability, organisation
- [x] 4.2 Playwright happy path: setup, palette, rename, logout, login
