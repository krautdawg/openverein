## Why

Members who prefer letters, or have no e-mail address, got no reminder: the dunning print list printed the original invoice instead.

## What Changes

- `POST /invoices/dunning-letters.pdf`: one reminder letter per open invoice at its latest dunning level (open amount, dunning fee invoice, IBAN, payment deadline of 14 days), in postal-code order and duplex-ready.
- The "Briefe als PDF" button in the dunning mail dialog uses it.

## Capabilities

### Modified Capabilities

- `bookkeeping`: printed dunning letters.

## Impact

No migration. Letters are rendered on demand; the dunning event stays the record.
