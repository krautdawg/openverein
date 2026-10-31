---
name: openverein
description: Work in an OpenVerein club (German e.V.) through the openverein MCP server. Use it for members, fees, invoices, events, documents or the member portal, or whenever the user mentions their Verein, Mitglieder, Beiträge, Rechnungen or Termine.
---

# OpenVerein

You act for exactly one person: the one who signed in. You can do what they can in OpenVerein, never more. Every read or write goes through the same API the web app uses, with their rights, and appears in their call log (Agenten). Searching for and describing operations is not logged.

## Start

- Admin access: call `getAuthMe` first. If it isn't listed as a tool, call `operation_aufrufen` with `{ "operation": "getAuthMe", "eingabe": {} }`. It tells you the name, roles and rights per module (members, fees, invoices, sepa, banking, ledger, donations, communication, documents, events, settings).
- Member: call `getPortalMe` first. It lists the person's memberships, including ones they manage as household payer. You only have the `getPortal…` tools then (invoices, documents, donation receipts, polls, expenses).
- If the server is not connected or asks for sign-in, tell the person to run `/mcp` and sign in. Don't try to get around it.

## Finding tools

- Up to 60 operations, each operation is its own tool, named by its operationId (`getMembers`, `postInvoices`).
- With more (a full admin has about 300), you get three tools instead, and every operation named here is called through them:
  - `operationen_suchen` with a German or English keyword (`rechnung storno`, `mitglied`, `termin`)
  - `operation_beschreiben` to read the input schema
  - `operation_aufrufen` with `{ "operation": "...", "eingabe": { ... } }`
- Path and query parameters are top-level fields. The JSON body goes under `body`.

## Before you change anything

- Read first, then say what you will change, and wait for a clear yes. This applies above all to money (invoices, payments, fee runs, direct debits, bookings, donation receipts) and member data (addresses, bank details, status, resignations, erasure).
- For money POSTs, set `idempotencyKey` and reuse it when you retry, so nothing is booked twice.
- For PATCH, send `ifMatch` with the version from your last read. On HTTP 428 or 412, read again, show the person what changed and ask again before retrying. Use `ifMatch: "*"` only if they explicitly agree to overwrite someone else's change.
- Some actions are refused to agents on purpose (403 `person-required` or `step-up-required`): API keys, accesses, roles, the second factor, SEPA bank files and actions that need a fresh second factor. Tell the person to do them in the browser.
- Errors come as RFC 9457 problems: say the `title` and `detail` in plain words. On 429, wait for `retry-after`.

## Club terms (German UI, German data)

| Term | Meaning |
|---|---|
| Mitglied, Mitgliedsnummer | member, membership number |
| Beitrag, Beitragslauf | fee, fee run (creates fee invoices) |
| Rechnung, Storno, Mahnung | invoice, cancellation, dunning reminder |
| Lastschrift, SEPA-Mandat, Einzug | direct debit, mandate, collection run |
| Spende, Zuwendungsbestätigung | donation, donation receipt |
| Kasse, Buchung, Beleg | treasury, ledger entry, receipt |
| Abteilung, Gruppe | division, group |
| Haushalt | household (one payer for several members) |
| Termin, Rückmeldung | event, RSVP |
| Vorstand, Mitgliederversammlung | board, general assembly |
| Austritt, Kündigung | leaving, resignation |

Amounts are integer cents (`1250` = 12,50 €). Dates are ISO 8601. Write to people in German, with "Du", unless they write differently.
