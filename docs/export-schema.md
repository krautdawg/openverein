# Full export format (schema version 1)

Admins create the export under Einstellungen → Gesamtexport (`POST /api/v1/exports/full`, fresh second factor required). It runs as a background job: the call answers 202 with the job, `GET /api/v1/jobs/:id` reports progress and, when done, `resultFileId`. It is stored encrypted for 7 days (and deleted when a person is anonymised); a download needs a fresh second factor too (`POST /api/v1/exports/full/:id/link` returns a link valid 60 seconds). Every creation and download is audit-logged. The whole export is read in one consistent snapshot.

## Layout

```
manifest.json
data/<table>.jsonl   one JSON object per line, one line per row
data/<table>.csv     the same rows for spreadsheets (UTF-8 with BOM, ";" separated, formula-safe)
files/<sha256>       every stored file once, named by its SHA-256 (see data/file.jsonl for names and owners)
```

## manifest.json

| Key | Meaning |
|---|---|
| `schemaVersion` | `"1"`; bumped when this document changes incompatibly |
| `exportedAt` | ISO timestamp |
| `organizationId` | id of the exported club |
| `databaseVersion` | name of the last applied migration (`migrations/NNNN_*.sql`) |
| `counts` | rows per table |
| `missingFiles` | SHA-256 of stored files that were not readable (should be empty) |
| `corruptFiles` | SHA-256 of stored files whose bytes no longer match their hash (should be empty) |
| `undecryptable` | count per `table.column` of encrypted values that could not be decrypted (should be empty; check `DATA_KEY`) |
| `files` | SHA-256 of every other entry in the ZIP, by path |

## Rows

- Tables and columns are those of the database at `databaseVersion` (see `migrations/`). Every table with an `organization_id` is exported with the club's rows; `receipt_line`, `donation_receipt_item`, `datev_export_entry`, `household_rule`, `assembly_item` and `assembly_attendance` through their parent.
- Dates and timestamps are ISO strings; binary columns (stored PDFs, DATEV ZIPs) are `{ "base64": "…" }` in JSONL and left out of the CSV.
- Encrypted columns are exported decrypted under the name without `_encrypted` (for example `sepa_mandate.iban`); IBAN change requests from the portal are decrypted in `change_request.old_value` / `new_value`.
- CSV headers come from the schema, so empty tables still have their header row.
- Never exported: sessions, portal sessions, login codes, recovery codes, idempotency keys, password hashes, invitation and API token hashes, TOTP secrets, keyed lookup hashes (`*_hash` blind indexes).

## Restoring

Importing a full export into an empty instance (round trip) is not implemented yet; the format keeps primary keys and references so that it can be.
