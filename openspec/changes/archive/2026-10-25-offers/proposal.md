## Why

P21 (P2.7): clubs that rent rooms or sell merchandise send offers before invoices. The article catalogue exists (#47); offers were missing.

## What Changes

- **Offers:** drafts with lines (net or gross), cover and closing text, and a validity date (default 30 days).
- **Issue:** assigns a number from their own range (`A-{YYYY}-{seq:4}`) and stores the PDF. The database freezes the content after that.
- **Status:** sent, accepted or declined, and **convert once** into an invoice draft with the same lines.
- **Accounting:** an offer is never a receivable and never in the ledger (separate tables, not an invoice kind).
- **Access:** club-wide invoice rights.
- **Web:** "Angebote" tab under Rechnungen, sharing the invoice form.

## Capabilities

### Modified Capabilities

- `invoicing`: offers.

## Impact

Migration `0051_offers.sql` (`offer`, `offer_line`, guards, number pattern).
