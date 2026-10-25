## Why

Every e.V. has to show income and expenses by sphere. Slice 11 adds the cash-basis bookkeeping core: a balanced, append-only journal that payments flow into automatically, a booking form for everything else, the GoBD lock and the EÜR.

## What Changes

- Chart of accounts per club (neutral numbers, DATEV number per account), tax rates as dated records (including 16 % and 5 % for the second half of 2020), cost centres, four tax spheres.
- Journal: balanced (deferred constraint trigger), append-only (update, delete and truncate refused in the database), gapless numbers.
- Cash basis: confirmed payment allocations post Bank/Kasse against the income account of the invoice kind; reversed allocations post a reversal; issuing an invoice posts nothing. A sync runs before every journal read, report and lock change.
- Booking form: income or expense with several lines and tax rates (net and tax split exactly), transfers between own accounts through the transit account; cash cannot go negative on any day.
- Reversal corrections; payment postings are corrected at the payment.
- GoBD lock date (database trigger for entries and payments); moving it back needs step-up and a reason, audited.
- Reports: EÜR by sphere and account with VAT totals and a warning panel (unmatched bank transactions, accounts without DATEV number, § 64 AO limit at 80 % and above 50,000 €), balances per account, CSV download.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bookkeeping`: neutral default chart with DATEV mapping instead of shipped SKR templates.

## Impact

Migration `0013_ledger.sql`. No new dependencies. Next slices: receipts and cash book, DATEV EXTF and the tax-audit export, donations and receipts, e-invoices.
