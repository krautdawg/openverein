## Why

Clubs switching from easyVerein bring years of member data. Slice 8 imports members from easyVerein's CSV export (or any CSV with a header) with a dry run, match keys and a rollback.

## What Changes

- CSV parsing with BOM, quoting and separator detection (; , tab); the browser decodes UTF-8 and falls back to Windows-1252.
- Column suggestions from German labels and easyVerein API names (easyVerein preset), editable mapping, unknown columns listed.
- Dry run per row: create, update, skip (duplicate in file) or error with reasons, using the same rules as the UI (dates, e-mail, IBAN, mandate reference).
- Match key: membership number, e-mail, or last name plus birth date; updates only fill fields the file has.
- Import creates persons, members (status from join and exit dates), groups (created when missing), group memberships and signed mandates (reference and date kept, recurring, `first_collected`).
- Every created row is tagged with its import run; a rollback deletes them while nothing depends on them and names the blocker otherwise.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `import`: member import first; easyVerein preset by header names.

## Impact

Migration `0011_imports.sql`. No new dependencies. Deferred (docs/decisions.md): XLSX, fees, invoices, bookings and custom fields from easyVerein, API pull, full data export, saved mapping profiles, value mapping for status columns.
