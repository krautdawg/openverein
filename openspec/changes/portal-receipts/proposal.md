## Why

S18 lists "my donation receipts" among the portal pages; members asked the treasurer for copies by e-mail.

## What Changes

- `GET /portal/donation-receipts` and `GET /portal/donation-receipts/:id/pdf` return the member's own receipts, never via the household payer: a receipt is the donor's tax document.
- A cancelled receipt stays listed as cancelled but is not handed out (410).
- Portal → Dokumente shows "Deine Zuwendungsbestätigungen" above the shared documents.

## Capabilities

### Modified Capabilities

- `portal`: donation receipts.

## Impact

No migration.
