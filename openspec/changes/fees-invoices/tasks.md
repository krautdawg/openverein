## 1. Data and engine

- [x] 1.1 Migration: fee plans, versions, assignments (one-main constraint), fee runs, assessments (double-billing guard), invoices and lines (immutability triggers), allocations, dunning events, letterhead settings
- [x] 1.2 Pure fee engine with unit and property tests
- [x] 1.3 IBAN/BIC validation

## 2. API

- [x] 2.1 Fee plans, versions, retire/delete; member fee assignments, payment method, calculator
- [x] 2.2 Fee runs: preview, stale check, post, cancel
- [x] 2.3 Invoices: drafts, issue, cancel, PDF with GiroCode, payments, reversal, write-off
- [x] 2.4 Open items, dunning proposal, dunning levels with fee invoices, dunning hold
- [x] 2.5 Organisation letterhead, bank details, number patterns, payment terms

## 3. Web

- [x] 3.1 Fees pages: plans with price history, fee runs list and preview with exclusion and two-step posting
- [x] 3.2 Invoices list with views and sums, invoice sheet with actions, invoice editor, dunning page
- [x] 3.3 Member sheet: payment method, fee assignments, calculator, invoices
- [x] 3.4 Settings: letterhead, bank, invoice numbering

## 4. Verification

- [x] 4.1 Integration tests: one main plan, intervals, billed-period protection, calculator, run posting, stale preview, catch-up exclusion, run cancellation, DB guards, gapless concurrent numbering, immutability, payments, PDF bytes, dunning, write-off, permissions
- [x] 4.2 Playwright: plan, assignment, run, invoice, payment
