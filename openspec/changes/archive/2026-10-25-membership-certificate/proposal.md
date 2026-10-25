## Why

P2.5 lists member certificates. Members need a Mitgliedsbescheinigung for student or pension discounts, employers or courts; the board writes them by hand.

## What Changes

- `GET /members/:id/certificate.pdf` (scoped; birth date only for users who may see it) and `GET /portal/members/:id/certificate.pdf` (own memberships): the club's letterhead, member since, until (former members) or notice to (resigned), visible groups, membership number, place, date and a signature line. Admin downloads are audited.
- Download links in the member sheet and on the portal card.

## Capabilities

### Modified Capabilities

- `members`: membership certificate. Member ID cards come later.

## Impact

No migration.
