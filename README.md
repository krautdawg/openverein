# OpenVerein

Open-source club management for German registered associations (e.V.): members, groups, fees and invoices, SEPA direct debit, bookkeeping, events, mail, documents and a member portal. Self-hostable, every record exportable, every action available over a REST API.

Licence: [AGPL-3.0](LICENSE). Status: early development, built slice by slice (see `openspec/`).

## What it does

| Area | Highlights |
|---|---|
| Members | Dated group memberships, households with a payer and family discount, custom fields, duplicates, saved views, bulk actions, age-based group change, census for the sports federation, honours, work hours, PDF and vCard lists |
| Money | Effective-dated fees with a mandatory run preview, invoices and dunning, SEPA direct debit and credit transfers, CAMT import with matching, XRechnung out and in (ZUGFeRD/UBL/CII), article catalogue, letters as one duplex PDF |
| Books | Cash-basis EÜR on an append-only balanced journal (GoBD lock date, reversals), receipts and cash book, DATEV export, budget vs. actual, volunteer allowances, donations and BMF receipts (money and in kind) |
| Club life | Events with RSVP, waitlist and attendance, public calendar widget, mail with templates and delivery log, documents, general assemblies and board meetings with minutes |
| Portal | Member self-service: data changes, invoices with GiroCode, documents, expense claims, household proxy for the payer |
| Platform | Roles with division scope and field restrictions, TOTP for finance, API tokens and OpenAPI, signed webhooks, background jobs, full export, GDPR tooling, `ovctl` for install, backup, restore and update |

## Run it locally

Requirements: Node 24, Docker.

```sh
cp .env.example .env
npm install
npm run dev
```

`npm run dev` starts Postgres and Mailpit in Docker, applies migrations, and runs the API on http://localhost:3300 and the web app on http://localhost:5173. The first visit asks you to set up your club. Mail sent by the app lands in Mailpit at http://localhost:18025.

API reference: http://localhost:3300/api/docs (OpenAPI document at `/api/v1/openapi.json`).

### Try the demo club

```sh
npm run seed:demo    # loads "SV Lindenhof 1921 e.V." with 150 fictitious members into an empty instance
npm run dev
```

Sign in with `demo@openverein.example` / `verein-demo-2026`. `npm run seed:demo -- --reset` wipes a demo instance and loads it again; it refuses to touch an instance that holds a real club. With `DEMO_MODE=true` the server loads the demo by itself, resets it every `DEMO_RESET_HOURS` (default 24), sends no real mail, shows a demo banner and watermarks every PDF, and locks accounts, roles, API keys, uploads and imports so a public demo stays usable for everyone. Club settings, texts and members stay editable for visitors until the next reset. The member portal shows the sign-in code on screen instead of mailing it. A server with `DEMO_MODE=true` refuses to start on an instance that holds a real club:

```sh
DEMO_MODE=true docker compose --profile app up --build
```

### Run the whole app in Docker

```sh
docker compose --profile app up --build
```

Then open http://localhost:3300.

## For the club

- [Handbuch für die Kasse](docs/handbuch-kasse.md): a club year from fees to the tax adviser, in German.
- [Verfahrensdokumentation (Vorlage)](docs/verfahrensdokumentation.md): GoBD procedural documentation template to fill in.

## Run it on a server

`./ovctl install` sets up Caddy (HTTPS), the app and Postgres with Docker Compose; `./ovctl backup`, `restore`, `update` and `doctor` keep it running. See [docs/operations.md](docs/operations.md).

## Tests

```sh
npm run typecheck && npm run lint
npm test            # unit and integration tests (needs the Postgres container)
npm run test:e2e    # Playwright end-to-end tests
npm run validate:xrechnung  # sample e-invoices through the official KoSIT validator (needs Java 17+ or Docker)
```

## How the project is organised

- `openspec/specs/` is the source of truth for behaviour, one spec per capability. Every slice is built through an OpenSpec change in `openspec/changes/` and archived when merged.
- `src/server/` Fastify API, `src/web/` React app, `src/shared/` schemas used by both, `migrations/` forward-only SQL.
- `docs/adr/` architecture decisions, `docs/decisions.md` smaller decisions.
- `PRODUCT.md` and `DESIGN.md` describe the product and the design system.
- `android/`, `ios/`, `capacitor.config.ts`, `codemagic.yaml`: mobile apps that wrap the web build, see [docs/mobile.md](docs/mobile.md).
