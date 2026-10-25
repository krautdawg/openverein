## Why

The treasurer presents a Kassenbericht at every general assembly: balances at the start and end of the year, income and expenses, the result by sphere. Today it is copied out of the software into a document.

## What Changes

- `GET /ledger/reports/treasurer.pdf?year=`: balances per money account on 1 January and 31 December, result by sphere, income and expenses by account, the data-quality hints of the EÜR, and a signature line. Audited.
- The EÜR page links the report for the year the chosen range starts in.
- The EÜR and balances queries are now functions shared by the JSON reports and the PDF.

## Capabilities

### Modified Capabilities

- `bookkeeping`: treasurer's report PDF.

## Impact

No migration.
