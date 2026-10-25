## Why

Invoices for members who prefer letters (or have no e-mail) were listed as single PDF links. For a fee run of 400 members with 60 letters, that is 60 downloads. M28 asks for one printable PDF in postal-code order, ready for duplex printing.

## What Changes

- `POST /invoices/letters.pdf` merges the stored, unchanged invoice PDFs. Letters are sorted by postal code, and each one is padded to an even page count. Scope checks run per invoice. The action is audit-logged with the invoice numbers.
- The send dialog offers "Alle N Briefe als ein PDF".

## Capabilities

### Modified Capabilities

- `communication`: letter batches for invoices. The batch is not stored, and there is no per-document "sent by letter" record; donation receipts and dunning letters come later.

## Impact

New dependency `pdf-lib` (MIT, no transitive dependencies) for merging PDFs; pdfkit cannot read existing PDFs.
