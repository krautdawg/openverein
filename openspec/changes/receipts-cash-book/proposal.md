## Why

Every expense needs a voucher, and a club with a cash box needs a cash book. Slice 17 adds supplier receipts with files, self-issued receipts and the cash book.

## What Changes

- Supplier receipts: supplier, number, date, due date, lines (amount, expense account, tax rate, text; sphere and cost centre via API), file (PDF, photo from the phone camera, ZUGFeRD/XRechnung stored unchanged, 8-year voucher retention), note.
- States: open → paid (posted to the journal on the payment date, cash basis) → void (posting reversed). Paid receipts are frozen in the database.
- Warnings, not refusals: same supplier and number, same file hash (also on upload).
- Self-issued receipt (Eigenbeleg): date, purpose, amount, reason, signer; PDF rendered, stored as voucher, booked.
- Cash book per money account: numbered entries in order with running balance, opening/closing balance, receipt links; PDF export (audited). Cash cannot go negative (existing check, also for receipts).
- Booking line logic moved into the ledger service so receipts and manual bookings share it.
- Web: Buchhaltung → Belege (status filter, create sheet with drop zone, pay, void, Eigenbeleg) and Kassenbuch.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bookkeeping`: "recorded" and "open" are one state; e-invoice contents are not parsed (lines entered by hand).

## Impact

Migration `0020_receipts.sql`; journal source `receipt` (already allowed).
