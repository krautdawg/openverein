## Why

A client that times out and retries must not create a second invoice, payment or booking. The API spec asks for idempotency keys on money writes.

## What Changes

- `Idempotency-Key` header required on POSTs that create money objects (invoices and their issue/cancel/payments/write-off/dunning, fee-run posting, collection runs, bank allocations, ledger bookings, DATEV exports, donations, donation receipts and the annual run); missing → 400 problem.
- First successful response stored per club, actor and key for 24 hours; a repeat with the same route and body gets the stored response (`Idempotent-Replayed: true`); a different body → 422; a repeat while the first is running → 409. Failed attempts free the key, so a retry after a fix or a second-factor prompt works.
- Web client sends a fresh key per POST and reuses it for the step-up retry; demo seed and tests send keys.
- Hourly prune of old keys.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api`: failed attempts do not occupy the key.

## Impact

Migration `0017_idempotency.sql`.
