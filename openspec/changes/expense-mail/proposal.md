## Why

Members who submitted an expense claim in the portal had to look again to learn the decision (gap noted in #43).

## What Changes

- On approval or rejection the member gets an e-mail (system text "Auslage entschieden", editable like the other system texts) with the amount, the purpose and, when rejected, the reason. A mail problem never undoes the decision.

## Capabilities

### Modified Capabilities

- `member-portal`: expense claim decision mail.

## Impact

Migration `0042_expense_mail.sql` (template key).
