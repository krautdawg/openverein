## Why

A club must be able to take all its data elsewhere at any time; it is the opposite of lock-in. The import spec asks for a full export with a manifest of hashes, admin-only with a fresh second factor.

## What Changes

- `POST /exports/full` (admin + step-up): ZIP with `data/<table>.jsonl` and `.csv` for every club table, stored files under `files/<sha256>`, and `manifest.json` (schema version, export time, database version, counts, SHA-256 of every entry, missing files).
- Encrypted columns exported decrypted; credentials, tokens, sessions and keyed hashes never exported.
- Stored for 7 days as a temporary file (`file.purpose = 'export'`, hidden from documents); list and download for admins; creation and every download audit-logged.
- Web: Einstellungen → Gesamtexport (admins).
- `docs/export-schema.md` documents format version 1.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `import`: no `ovctl export-all` CLI and no import/round trip yet.

## Impact

Migration `0023_full_export.sql`.
