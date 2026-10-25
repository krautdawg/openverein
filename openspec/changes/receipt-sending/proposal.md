## Why

M28 / M26: in January the treasurer issues the annual donation receipts and must get them to the donors. Receipts could be issued but not sent.

## What Changes

- `POST /donation-receipts/send`: e-mail with the stored PDF through the mail queue (system text "Zuwendungsbestätigung", placeholder `{{bestaetigung}}`); each receipt only once unless `resend`; donors who prefer letters or have no usable address are listed.
- `POST /donation-receipts/letters.pdf`: one duplex-ready PDF in postal-code order.
- The letter merge is shared with the invoice letters (`src/server/letters.ts`).
- The receipts page has "Bestätigungen verschicken" with the letter PDF afterwards; the message list marks these mails.

## Capabilities

### Modified Capabilities

- `bookkeeping`: sending donation receipts.

## Impact

Migration `0044_receipt_sending.sql` (message kind, delivery link, template key).
