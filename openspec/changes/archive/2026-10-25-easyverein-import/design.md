## Decisions

- **Header names, not a fixed layout.** easyVerein's export columns follow the UI labels and can change; the preset recognises synonyms (German labels and API field names) and every column stays editable. The fixture in `tests/fixtures` follows the visible labels and must be checked against a real export before go-live.
- **Status from dates.** The importer derives `active`, `future`, `resigned` or `former` from join and exit dates instead of mapping status texts.
- **Mandates as signed and used.** Imported mandates keep reference and signature date, are active and marked as collected, so the next run is RCUR without an amendment.
- **Rollback by tag.** Created rows carry `import_run_id`; updates to existing members are not rolled back (stated in the UI).
