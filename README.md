# OpenVerein

Open-source club management for German registered associations (e.V.): members, groups, fees and invoices, SEPA direct debit, bookkeeping, events, mail, documents and a member portal. Self-hostable, every record exportable, every action available over a REST API.

Licence: [AGPL-3.0](LICENSE). Status: early development, built slice by slice (see `openspec/`).

## Run it locally

Requirements: Node 24, Docker.

```sh
cp .env.example .env
npm install
npm run dev
```

`npm run dev` starts Postgres and Mailpit in Docker, applies migrations, and runs the API on http://localhost:3300 and the web app on http://localhost:5173. The first visit asks you to set up your club. Mail sent by the app lands in Mailpit at http://localhost:18025.

API reference: http://localhost:3300/api/docs (OpenAPI document at `/api/v1/openapi.json`).

### Run the whole app in Docker

```sh
docker compose --profile app up --build
```

Then open http://localhost:3300.

## Tests

```sh
npm run typecheck && npm run lint
npm test            # unit and integration tests (needs the Postgres container)
npm run test:e2e    # Playwright end-to-end tests
```

## How the project is organised

- `openspec/specs/` is the source of truth for behaviour, one spec per capability. Every slice is built through an OpenSpec change in `openspec/changes/` and archived when merged.
- `src/server/` Fastify API, `src/web/` React app, `src/shared/` schemas used by both, `migrations/` forward-only SQL.
- `docs/adr/` architecture decisions, `docs/decisions.md` smaller decisions.
- `PRODUCT.md` and `DESIGN.md` describe the product and the design system.
