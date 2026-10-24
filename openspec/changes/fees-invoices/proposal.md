## Why

Collecting membership fees is the job treasurers fear most: who owes what for which period, without ever charging twice. Slice 2 turns fee rules into invoices through a preview the treasurer checks first, with the database guaranteeing that no day is billed twice.

## What Changes

- Fee plans with effective-dated price versions (amount in cents, one-off or 1–60 months, calendar or entry anchor, monthly proration or full amount, admission fee) and a line-text template.
- Fee assignments per member (one main plan at any date by exclusion constraint, add-on plans, individual amount with mandatory reason), payment method per member, a fee calculator that explains each line without posting.
- Pure TypeScript fee engine with property tests (every interval 1–60, both anchors, split runs equal one run, no day billed twice).
- Fee runs: preview snapshot with catch-up lines, warnings and per-line exclusion; posting refuses stale previews; assessments guarded by `assessment_no_double_billing`; cancellation of a whole run through cancellation documents.
- Invoices: drafts, gapless numbers on issue, immutable after issue (database trigger), cancellation documents with their own number range, credit notes, PDF on a DIN 5008 letter with EPC QR (GiroCode), stored once with SHA-256.
- Payments recorded by hand (allocations), reversal, open items, dunning proposal and levels with fees as separate invoices, dunning hold, write-off.
- Letterhead and bank settings, invoice number patterns, payment terms.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `fees-and-invoices`: adds the concrete rules for posting runs with zero-amount lines, PDFs rendered once on first download, and payment allocation limits.

## Impact

Migration `0004_fees_invoices.sql`. Dependencies: `pdfkit`, `lean-qr`, `source-sans` (OFL font files), dev `fast-check`. ADR 0002 records the PDF deviation from Typst. Deferred (see `docs/decisions.md`): households and family discounts, credit-balance offset, day-based proration, recurring invoice templates, scheduled previews, bookkeeping postings for payments and write-offs, sending dunning letters.
