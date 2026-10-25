## Why

M6 (should): clubs decide what members may do in the portal. Some don't want resignations or bank changes online; youth groups shouldn't see invoices.

## What Changes

- The club switches six portal functions: edit own data, change bank details, see invoices, show the mandate, resign, show the club contact.
- Each group overrides a function with allow or deny. A member gets a function if one of their current groups allows it and none denies it; otherwise the club setting applies.
- The server enforces it: change requests and resignation get 403, invoices are filtered (list, PDF, QR), and the mandate and contact are left out of `/portal/me`. The portal hides what is switched off.

## Capabilities

### Modified Capabilities

- `portal`: portal settings with group overrides.

## Impact

Migration `0046_portal_settings.sql` (`organization.portal_features`, `club_group.portal_overrides`). Everything stays on by default.
