## Why

XRechnung files were created and stored at issue, but never sent. Public bodies expect the XML in their e-invoice mailbox (BT-49), not only a PDF to a general address.

## What Changes

- Invoice mails for e-invoiced invoices carry the XRechnung XML next to the PDF.
- They go to the recipient's e-invoice address when it is an e-mail address; a letter preference does not apply to them.

## Capabilities

### Modified Capabilities

- `bookkeeping`: e-invoice delivery by e-mail. Delivery through PEPPOL or authority portals (ZRE/OZG-RE) stays manual.

## Impact

No migration.
