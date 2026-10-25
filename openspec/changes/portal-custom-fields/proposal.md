## Why

Clubs mark some custom fields as visible to members (shirt size, licence date). The member portal should show them.

## What Changes

- `GET /portal/me` returns, per membership, the club's active custom fields flagged `visible_to_member` with their values as text.
- The portal card lists them under the address.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `member-portal`: editing custom fields from the portal (`editable_by_member`) comes later with the change-request flow.

## Impact

No migration.
