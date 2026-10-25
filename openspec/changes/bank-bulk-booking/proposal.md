## Why

M13 (should): bank fees, grants and postage show up every month without an invoice. Until now each one was ticked off and then booked again by hand in the ledger.

## What Changes

- Select several open movements in Bank → Abgleich and book them to one income or expense account, with a shared sphere, cost centre and tax rate.
- Each movement gets its own journal entry, on its own date and on the bank's ledger account (or else the default bank account), and moves to the new status "Gebucht".
- Mixed income and expense is refused.
- "Stornieren" on a booked movement posts a reversal dated today and reopens the movement.

## Capabilities

### Modified Capabilities

- `banking`: booking movements without an invoice.

## Impact

Migration `0049_bank_booking.sql` (status `booked`, `journal_entry_id`, and a check that the two go together).
