# Test debt

Guards that review fixes added without a test of their own, and the tests that now cover them. Every test was run
against the code before its fix and failed there (how is listed per row), except where noted.

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
| G17 / #113 | Archived-person trigger locks, then reads | `testDebt` "archived person" (a table with the trigger and no foreign key) | **no**: the old trigger (0064) also waits and is refused. PostgreSQL 18 waits for the archiving transaction and re-checks the row even with the status filter inside the `FOR SHARE` subquery. 0071 stays as the form that does not rely on this; the test checks the behaviour |
| G9 / #104, G17 / #113 | `ovctl restore` never prunes its own target (backup folder spelled `./backups/`) | `scripts/ovctl-roundtrip.sh`, restore part | yes: `ovctl` from before #113 deletes the target and stops at the dropped database |
| G11 / #106 | Failed `ovctl update` rolls code and data back | `scripts/ovctl-roundtrip.sh`, update part (a broken release is pushed to the clone's origin) | yes: `ovctl` from before #106 only prints the commands (HEAD stays on the broken release) |
| G9 / #104 | Backup and restore keep database and files together | `scripts/ovctl-roundtrip.sh` (club name and a marker file restored) | the first live run; there was no earlier test to fail |

Not covered by a test:

- The future-date check on portal expense submission (`POST /portal/expenses`): the approval check above covers the
  money path; the submission check is the same comparison.
- Streaming exports above 4 GB (deferred, see decisions.md).
