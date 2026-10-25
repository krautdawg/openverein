## Why

Treasurers, admins, tax advisers and cash auditors reach bank data and money. The auth spec makes a second factor mandatory for them and asks for a fresh confirmation before critical actions.

## What Changes

- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) without new dependencies; setup with QR code and manual key, confirmation with a code, ten single-use recovery codes (hashed).
- Mandatory for users with write access to fees, invoices, SEPA, banking, ledger or donations and for the tax-adviser and cash-auditor roles: finance modules answer `totp-required` on every request until it is set up; a banner links to the setup.
- Sign-in with TOTP: password → short-lived signed ticket → code or recovery code → session; wrong codes count toward the progressive lockout; a code's time step can be used once.
- Step-up: generating and releasing collection runs, creating API tokens, changing roles and users require a confirmation from the last ten minutes; the web app asks for a code and retries the request.
- Sessions list with "sign out other sessions"; admins can reset another user's second factor (sessions end).
- Demo club and demo mode skip the second factor (shared account).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `auth`: replay protection and admin reset.

## Impact

Migration `0012_totp.sql`. No new dependencies. Deferred: step-up for lock-date moves, donation receipts and the full export (those features do not exist yet; the helper `requireStepUp` is ready).
