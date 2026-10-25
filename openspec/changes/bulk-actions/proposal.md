## Why

M08 asks for bulk actions over all filter results, with a confirmation that shows the count and sample records, and jobs for large selections. The members list could only act on hand-picked rows of the loaded page, with no confirmation, and the result message vanished with the selection.

## What Changes

- `GET /members/ids?<filter>`: all matches of the current filter (scoped, at most 5,000) plus the first five names.
- "Alle N Treffer auswählen" once every visible row is selected.
- Bulk actions ask first: count, action, date, group and five sample names.
- Over 100 members the action runs as a `member_bulk` job (selection frozen in `params`, per-record outcome in `result`, with the starting user's current rights and scope); the tray shows it.
- "E-Mail schreiben" opens the composer with the selection.
- The outcome message stays visible after the selection clears.

## Capabilities

### Modified Capabilities

- `members`: bulk actions over filter results. More actions (status, invoices, portal invitations, GDPR sheets) come later.

## Impact

Migration `0026_bulk_jobs.sql`: `job.params`, `job.result`, kind `member_bulk`; the one-at-a-time rule now applies to the export only.
