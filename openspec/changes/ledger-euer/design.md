## Decisions

- **Neutral chart, DATEV mapping per account.** The SKR 42 / SKR 49 lists are DATEV material we cannot verify here; shipping wrong numbers is worse than shipping none. Every account carries a DATEV number that the tax adviser fills in; the DATEV export will refuse accounts without one.
- **Database guards.** Balance (deferred constraint trigger), append-only (row and truncate triggers) and the lock date (insert triggers on journal entries and allocations) hold for every code path, including future ones.
- **Postings follow payments by sync.** One idempotent function (unique index per source) posts allocations and reversals before reads, reports and lock changes. No call site can forget it, and payments made before the ledger existed are posted on first use.
- **Net from gross.** `net = round(gross / (1 + rate))`, `tax = gross − net`, so lines always add up to the cent.
