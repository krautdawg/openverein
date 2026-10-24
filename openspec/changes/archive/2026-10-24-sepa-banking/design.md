## Context

Deliverable A specifies an in-house pain.008/pain.001 serializer with XSD validation, CAMT parsing on a hardened `fast-xml-parser`, encrypted IBANs with an HMAC blind index, and a partial unique index as the double-debit guard.

## Goals / Non-Goals

**Goals:** never debit an invoice twice; never send an invalid file to the bank; bank data encrypted at rest; matching that books only what is certain and suggests the rest.

**Non-Goals:** online banking (FinTS), mandate amendments, ledger postings, e-mail pre-notifications.

## Decisions

- **Pre-notification on the invoice.** Clubs announce direct debits on the invoice. The issue snapshot freezes the mandate reference and creditor ID; the PDF states amount, earliest collection date (due date), mandate reference and creditor ID. A run refuses invoices due after the collection date.
- **Always RCUR (OOFF for one-off mandates).** Allowed since the 2016 SEPA rulebook; no FRST bookkeeping.
- **One item per invoice.** Simple, transparent end-to-end IDs (`OV` + run id + position). The `collection_item_invoice` table still allows several invoices per item later.
- **Live window.** A run counts as live from the first download. Releasing a downloaded run requires an explicit statement that the file was never submitted (audited). TOTP step-up follows with the auth hardening slice.
- **XSD validation in-process** with `libxml2-wasm` and the official ISO 20022 schemas; a file that fails is never stored.
- **Encryption.** AES-256-GCM per field with keys derived (HKDF) from `DATA_KEY`; the blind index uses a separate derived key. Stored SEPA files are encrypted as well; a SHA-256 of the plain file proves the bytes never change.
- **CAMT hardening.** Any `<!DOCTYPE` or `<!ENTITY` is refused before parsing; entities are never processed; 50 MB cap.
- **Matching runs after each import and on demand,** in one transaction per bank transaction with row locks, so concurrent runs cannot double-allocate.

## Risks / Trade-offs

- [Lost DATA_KEY] → encrypted IBANs and files are unreadable; documented next to backups.
- [Batch credit matched by control sum] → only when every item of the file is still open and the dates fit (collection date to +10 days).
- [CSV dialects] → header recognition covers the common German exports; unknown layouts fail with a clear message.
