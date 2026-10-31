# OpenVerein

Open-source club management for German registered associations (e.V.): members, groups, fees and invoices, SEPA direct debit, bookkeeping, events, mail, documents and a member portal. Self-hostable, every record exportable, every action available over a REST API.

Licence: [AGPL-3.0](LICENSE). Status: early development, built slice by slice (see `openspec/`).

## What it does

| Area | Highlights |
|---|---|
| Members | Dated group memberships, households with a payer and family discount, custom fields, duplicates, saved views, bulk actions, age-based group change, census for the sports federation, honours register and greeting mails, contact log, data-quality warnings, work hours, membership certificates, PDF and vCard lists |
| Money | Effective-dated fees with age brackets, a mandatory run preview and an optional monthly automatic preview, offers convertible into invoices, invoices with default texts and net or gross prices, dunning with printed letters, SEPA direct debit (remittance template) and credit transfers, CAMT import with matching, XRechnung out and in (ZUGFeRD/UBL/CII), article catalogue, letters as one duplex PDF |
| Books | Cash-basis EÜR on an append-only balanced journal (GoBD lock date, reversals), receipts and cash book, bank movements booked in bulk, own tax rates, DATEV export, treasurer's report PDF, budget vs. actual, volunteer allowances, donations and BMF receipts (money and in kind) sent by mail or letter |
| Club life | Events with RSVP, waitlist and attendance lists for grants, ICS feed and import, public calendar widget, mail with templates and delivery log, documents with folder access, inventory and lending, polls, tasks, general assemblies and board meetings with minutes |
| Portal | Member self-service: data changes, invoices with GiroCode, documents, polls, expense claims, household proxy for the payer, functions switchable per club and group |
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
- [Handbuch für Vorstand und Verwaltung](docs/handbuch-verwaltung.md): members, intake, events, mail, portal and privacy, in German.
- [Verfahrensdokumentation (Vorlage)](docs/verfahrensdokumentation.md): GoBD procedural documentation template to fill in.

## Mit Claude Code verbinden

The plugin connects Claude Code to a club through the remote MCP server at `<club>/mcp`. Your agent sees and does what you see and do in the club administration or the member portal, nothing more.

1. Install the plugin in Claude Code:

   ```
   /plugin marketplace add krautdawg/openverein
   /plugin install openverein@openverein
   ```

   On Claude Code 2.1.275 or later this also works in one step: `/plugin install openverein --marketplace krautdawg/openverein`.

2. Enter your club's address when asked, for example `https://verein.example.org`. To try the public demo, enter `https://klub2.ki-klub-werder.de`. You can change it later with `/plugin configure openverein@openverein`; then sign in again. From a shell, the address comes with the install command: `claude plugin install openverein@openverein --config club_url=https://verein.example.org`.

3. Sign in: run `/mcp`, choose `openverein` and authenticate. In the browser:
   - members sign in to the portal with their e-mail code
   - the club administration signs in with its normal login and second factor

   Before you sign in, check that the browser shows your club's address. Then choose read-only or read-and-write and allow access. No token ends up in any file.

4. Ask, for example, "Welche Rechnungen sind bei mir offen?" or "Wer hat sich für das Training am Dienstag angemeldet?".

You see the agent's calls, and can revoke its access, under **Einstellungen → Agenten** (or **Portal → Agenten**). Scripts and the `ov` command-line tool use a token from the same page instead of OAuth. claude.ai and ChatGPT connect to the same `<club>/mcp` address as a custom connector.

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
