# Product

<!-- impeccable:product-schema 1 -->

_Inferred from the owner's brief and the research in `saaskiller/easyverein/` (no interview round was possible in this unattended build; every fact below comes from those written sources)._

## Platform

web

## Stack

delegated: React 19 + Vite SPA on a Fastify REST API (OpenAPI) and PostgreSQL; the same web build is wrapped with Capacitor for iOS and Android. See `docs/adr/`.

## Users

Volunteers who run a German registered association (e.V.) with 100 to 2,000 members: the treasurer (Kassenwart), the board (Vorstand), division leads (Abteilungsleitung) and trainers. They do this work in the evening, after a day job, on a laptop at the kitchen table or on a phone between training sessions. Members themselves use the member portal to see their data, invoices and mandate.

## Product Purpose

OpenVerein is an open-source (AGPL-3.0) club management system: members, groups, fees and invoices, SEPA direct debit, bookkeeping, events, mail, documents and a member portal. It replaces easyVerein, a paid SaaS, so that a club owns its data, can self-host and can always export everything. Success: a treasurer runs a full fee cycle without a spreadsheet and without fear of charging a member twice.

## Positioning

Owned, open and exportable, with money paths that are provably safe (preview before every fee run, database guards against double billing and double debits). The functional reference is easyVerein; its UX (cluttered green header bars, endless modals, upsell banners) is the anti-reference.

## Operating Context

Real club rituals: the yearly or quarterly fee run, the SEPA collection file uploaded to the bank portal, bank statements downloaded as CAMT files, the general assembly, the tax adviser receiving a DATEV export. Volunteers switch between this app, online banking and e-mail. Every action in the UI must also be possible over the REST API, because a sister project builds an agent-first surface on the same domain.

## Capabilities and Constraints

See `openspec/specs/` (the source of truth for behaviour). German-first copy that addresses the user with "Du". Money is integer cents. No third-party trackers, fonts or captchas (GDPR). A public demo mode with a fake club, clearly marked as demo data, is part of the MVP.

## Brand Commitments

Name: OpenVerein. Owner's binding direction: it must feel like a top product designer built it; smooth, minimal, calm, fast. Typography-led, generous whitespace, one accent, dense-but-readable tables, keyboard-first (command palette, inline editing, side sheets instead of modal stacks). Banned: centred hero with gradient blob, three identical cards, glassmorphism, purple gradients, rounded-2xl + shadow-lg on everything, Inter-only typography, invented stats, emoji as icons.

## Evidence on Hand

No real club data, customers or testimonials. Demo content is synthetic and must be labelled as demo data wherever it appears. Screens of the reference product: `../saaskiller/easyverein/screens/30-app-*.png` (anti-reference).

## Product Principles

1. Nothing touches a member's bank account without a preview first.
2. Calm over clever: the tool disappears into the volunteer's task.
3. Every action is reachable by keyboard and by API.
4. The club owns its data: export everything, any time.

## Accessibility & Inclusion

WCAG 2.2 AA. Many volunteers are older; body text at least 15px, visible focus, no information carried by colour alone.
