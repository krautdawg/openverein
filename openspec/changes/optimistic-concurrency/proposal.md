## Why

Two board members editing the same member at the same time silently overwrite each other. The API spec asks for ETags and If-Match with 412 on stale writes.

## What Changes

- `version` on member detail, organisation and invoice details (from the change timestamps); `GET /members/:id` also sends it as `ETag`.
- `PATCH /members/:id`, `PATCH /organization` and `PATCH /invoices/:id` (drafts) compare `If-Match` with the stored version under a row lock and answer 412 (`stale`) when the record changed meanwhile.
- The web client sends `If-Match` for member and club settings edits; on 412 it reloads the record and shows the message.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api`: If-Match is honoured when sent, not yet required; other PATCH routes follow.

## Impact

No migration.
