# ADR 0002: PDF rendering with pdfkit instead of Typst

Date: 2026-10-24. Status: accepted.

## Context

Deliverable A picks the Typst CLI for every PDF (invoices, receipts, letters). That adds a native binary and fonts to the image and a template language contributors must learn.

## Decision

Render PDFs in-process with `pdfkit` (maintained, pure JavaScript) and draw the EPC QR code from `lean-qr` (zero dependencies). Embed Source Sans 3 TTF files from the `source-sans` package (SIL OFL) so every Latin Extended name renders. Layout follows DIN 5008 form B (address window at 45 mm).

`pdf-lib` was rejected: no release since 2022. `qrcode` was rejected: last release more than 90 days ago.

## Consequences

Documents are code (`src/server/invoices/pdf.ts`). If templates for many document types become unwieldy, revisit Typst for the letter slice. Issued documents are stored once, so changing the renderer never alters an existing PDF.
