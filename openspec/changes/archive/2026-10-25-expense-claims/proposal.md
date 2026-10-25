## Why

P2.6: members pay for balls, plasters and train tickets and hand in crumpled receipts. The treasurer types them in again. A claim in the portal with a photo of the receipt removes the paper loop.

## What Changes

- Portal → Auslagen: purpose, date, amount, account holder, IBAN (validated, stored encrypted) and the receipt (PDF or photo, max. 10 MB; other types refused). The upload is accepted only once and only fresh (one hour). Own claims with status and rejection reason.
- Buchhaltung → Belege shows submitted claims with the receipt and payout details (IBAN masked for roles without IBAN access). "Annehmen" chooses an expense account and creates an open receipt with the claim's file; it is paid and booked like any receipt. "Ablehnen" needs a reason the member sees.
- Claimed files become vouchers (8 years). Anonymisation clears the payout holder and IBAN of a person's claims.

## Capabilities

### Modified Capabilities

- `member-portal`: expense claims. E-mail notifications on decisions and a payout file (pain.001) for approved claims come later; the household proxy (P2.6) too.

## Impact

Migration `0029_expense_claims.sql`. CSRF guard: raw uploads also allowed on `/portal/expenses/files`.
