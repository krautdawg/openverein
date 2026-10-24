## Why

Members ask the board for their data, invoices and statutes, and send address changes by mail. Slice 7a gives them a portal on their phone: sign in with an e-mailed code, see memberships, invoices with GiroCode, shared documents, change data and resign. The board decides changes in one inbox. Online applications follow in slice 7b.

## What Changes

- Sign-in with a 6-digit code by e-mail (10 minutes, 5 attempts, scanner-safe link that only fills the form), admin-issued codes (24 hours, audited), separate portal sessions.
- One session per e-mail address shows every current membership under that address (families).
- Pages: overview with memberships, groups, mandate (masked), open amount; invoices with PDF and EPC QR for open transfers; documents from folders shared with members; data changes; resignation.
- Change requests: phone applies at once, other fields and IBAN wait for approval; newer requests supersede pending ones; e-mail and bank changes are announced to the address on file.
- Board inbox on the overview: accept or deny with a reason, decisions mailed; resignation acceptance sets notice and exit dates; IBAN acceptance amends the mandate and the next pain.008 carries the amendment (same bank: original account, new bank: SMNDA).
- PWA manifest and an offline page for the portal; offline banner; no offline writes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `member-portal`: identity by e-mail address, fixed field rules for the MVP.
- `sepa`: mandate amendments after an IBAN change.

## Impact

Migration `0009_portal.sql`. No new dependencies. Deferred (docs/decisions.md): row-level security, per-group portal function settings, donation receipts in the portal, passkeys/passwords for members, configurable field rules.
