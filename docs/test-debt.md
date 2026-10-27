# Test debt

Guards that review fixes added without a test of their own, and the tests that now cover them. Every test was run
against the code before its fix and failed there (how is listed per row). Database guards are checked against the old
state by leaving the newer migration files out: `tests/global-setup.ts` recreates the test database from the
migrations on every run, so editing it by hand before a run proves nothing.

Run the code tests with `npx vitest run tests/testDebt.test.ts`, the operations round trips with
`scripts/ovctl-roundtrip.sh` (Docker; also in CI, workflow "ovctl round trips").

| Group / PR | Guard | Test | Fails on the old code |
|---|---|---|---|
| G8 / #103 | Job lease: a reclaimed run stores no result | `testDebt` "job lease" (a test trigger reclaims the job at its first progress) | yes: `worker.ts` and `fullJob.ts` from before #103 store the export |
| G8 / #103, #113 | Export vs erasure | `testDebt` "export vs erasure" (an erasure with an old start time commits during the export) | yes, both without the guard (before #103) and with the timestamp check of #103 |
| G8 / #103 | Period lock counts reversed, never posted payments | `testDebt` "period lock" (`unpostedPayments`) | yes: `ledger/service.ts` from before #103 counts 0 |
| G9 / #104 | Bulk job retry returns the stored result | `testDebt` "bulk job" | yes: `bulkJob.ts` from before #104 applies the change again |
| G9 / #104 | Bulk scope decided under lock | `testDebt` "bulk scope" (a membership is ended in a transaction open during the bulk action) | yes: `bulk.ts` from before #104 adds the member |
| G10 / #105 | Expense claim with a future date is not approved | `testDebt` "expense claim" | yes: the approval goes through without the check |
| G10 / #105 | One invitation when two arrive at once | `testDebt` "assembly" (a test trigger pauses the first invitation) | yes: both send |
| G10 / #105 | Work-hour settlement waits for hours being logged | `testDebt` "work hours" | yes: `workHours.ts` from before #105 bills the missing hours |
| G12 / #107 | Full export without the poll voter | `testDebt` "poll answers" | yes: `member_id` is exported |
| G12 / #107 | Treasurer report carries the demo watermark | `testDebt` "treasurer report" (watermark colour in the content streams) | yes: `report-pdf.ts` from before #107 has none |
| G17 / #113 | Archived-person trigger locks, then reads | `testDebt` "archived person" (a table with the trigger and no foreign key) | yes: without migration 0071 (the 0064 trigger) the insert goes through. (A first check said otherwise: it edited the test database, which `tests/global-setup.ts` recreates from all migrations on every run. Old database states are checked by leaving the newer migration files out.) |
| G9 / #104, G17 / #113 | `ovctl restore` never prunes its own target (backup folder spelled `./backups/`) | `scripts/ovctl-roundtrip.sh`, restore part | yes: `ovctl` from before #113 deletes the target and stops at the dropped database |
| G11 / #106 | Failed `ovctl update` rolls code and data back | `scripts/ovctl-roundtrip.sh`, update part (a broken release is pushed to the clone's origin) | yes: `ovctl` from before #106 only prints the commands (HEAD stays on the broken release) |
| G9 / #104 | Backup and restore keep database and files together | `scripts/ovctl-roundtrip.sh` (club name and a marker file restored) | the first live run; there was no earlier test to fail |

Not covered by a test:

- The future-date check on portal expense submission (`POST /portal/expenses`): the approval check above covers the
  money path; the submission check is the same comparison.
- Streaming exports above 4 GB (deferred, see decisions.md).

## Second review pass (Codex) on groups reviewed by claude-counsel

| Group | Finding | Test | Fails on the old code |
|---|---|---|---|
| G6 | Idempotent replay needs the right today | `g6Second` "replays … only while the caller still has the right" | yes |
| G6 | An anonymised person stays final | `g6Second` "keeps an anonymised person final" | yes (without 0072) |
| G6 | A failed erasure replay stops the start | `g6Second` "does not start …" | yes |
| G6 | Legal hold vs anonymisation | `g6Second` "refuses a legal hold …" | yes |
| G6 | Donation sphere from its income account; no receipt for economic income | `g6Second` "books a donation in the sphere …" | yes |
| G6 | Donations are never deleted | `g6Second` "never deletes a donation" | yes (without 0072) |
| G6 | Reversals need an idempotency key; DATEV exports append-only | `g6Second` "needs an idempotency key …" | yes |
| G6 | Art. 15 covers every person-linked table and the stored files | `g6Second` "puts every person-linked table …" | yes |
| G13 | Net price with a quantity that changes the line total is refused | `g13Second` "refuses a net price …" | yes |
| G13 | Credit notes get no "please pay" default text | `g13Second` "gives a credit note …" | yes |
| G13 | Cancelled dunning fee not claimed on a letter | `fees` "proposes and applies dunning …" (`feeCents`) | yes |
| G13 | Long SEPA remittance keeps the invoice number | `g13Second` "keeps the invoice number …" | yes |
| G13 | Closing text in the XRechnung | `g13Second` "puts the closing text …" | yes |
| G13 | Non-member payer sees the household invoice (deny wins) | `portalVerify` "Codex review G13 …" | yes |
| G13 | Expense decision mail queued in the decision's transaction | `g13Second` "queues the expense decision mail …" | yes |
