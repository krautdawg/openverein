## Why

P28 / P3.7: clubs pay trainers and volunteers the tax-free Übungsleiter- and Ehrenamtspauschale (§ 3 Nr. 26 / 26a EStG). The limits apply per person across all payers; overpaying makes the excess taxable and possibly subject to social insurance. Treasurers track this in spreadsheets.

## What Changes

- Allowance payments per person, kind, date and purpose; declarations of what the person already uses elsewhere in the year.
- Year overview per person and kind: paid, elsewhere, limit, rest; payments past the limit are recorded and answered with a warning.
- Limits by year in one table (3,000 / 840 € until 2025, 3,300 / 960 € from 2026).
- Buchhaltung → Pauschalen. The payout itself is booked like any expense.

## Capabilities

### Modified Capabilities

- `bookkeeping`: volunteer allowance tracking.

## Impact

Migration `0036_allowances.sql`.
