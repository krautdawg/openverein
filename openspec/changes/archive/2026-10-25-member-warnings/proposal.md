## Why

M1 (should): the member record should warn about problems before the fee run finds them: no payment method, direct debit without a mandate, and that the person has access to the administration.

## What Changes

The member detail shows three more warnings:
- **"Keine Zahlungsart hinterlegt."** For a current member with an active fee assignment and no household payer.
- **"Zahlt per Lastschrift, aber es gibt kein gültiges Mandat."** The household payer's mandate counts.
- **"Hat einen Zugang zur Verwaltung."** An active user account with the same e-mail address.

The payment warnings only show to people who can see fees.

## Capabilities

### Modified Capabilities

- `members`: data-quality warnings.

## Impact

No migration. Two to three small queries per member detail.
