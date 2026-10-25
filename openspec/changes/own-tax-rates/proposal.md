## Why

M16 (must): tax rates are records with validity and accounts, and clubs can add their own. The records and seeds already exist; adding and ending a rate was missing.

## What Changes

- `POST /ledger/tax-rates` adds a rate: label, rate, validity, and an output- and/or input-tax account. The accounts must be tax accounts; a rate above 0 % needs at least one.
- `PATCH /ledger/tax-rates/:id` only changes the end of validity. It is refused when a line was already booked with the rate after the new end.
- The rate itself never changes after it is created.
- The accounts page gets a "Steuersätze" section with a table and an add form.

## Capabilities

### Modified Capabilities

- `bookkeeping`: own tax rates.

## Impact

No migration.
