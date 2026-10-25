## Why

P3.2: since 2025 suppliers increasingly send e-invoices (XRechnung XML, ZUGFeRD / Factur-X PDFs). Treasurers retype what the machine-readable file already says.

## What Changes

- Uploading a receipt file reads it as an e-invoice when it is XRechnung / UBL / CII XML or a PDF with embedded e-invoice XML. The file itself is stored unchanged, as before.
- The upload answer suggests supplier, number, issue and due date, total and gross per VAT rate; the receipt form fills those in (one line per VAT rate with the matching rate) and says so. The treasurer picks the accounts and saves as usual.
- XML with DOCTYPE or entities is not read (XXE); broken PDFs are simply not recognised.

## Capabilities

### Modified Capabilities

- `bookkeeping`: incoming e-invoice parsing for prefill. Validation with the KoSIT validator on upload and the human-readable view of XML-only invoices come later.

## Impact

No migration.
