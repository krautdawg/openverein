## Why

P09 (P2.5): division leads want printable member lists and contacts on their phone. Only CSV existed.

## What Changes

- `GET /members/export.pdf?<filter>`: printable list (A4 landscape: number, name, groups, phone, e-mail, address; header repeated per page, page numbers).
- `GET /members/export.vcf?<filter>`: one vCard 4.0 file for the filtered members (name, e-mail, phone, address, birthday, the club as category).
- Same filter and scope as the list and CSV; restricted fields (phone, e-mail, birth date) are left out; every export is audit-logged.
- The members header has one "Exportieren" menu (CSV, PDF, vCard) instead of a CSV button.

## Capabilities

### Modified Capabilities

- `members`: PDF list and vCard export. Member ID cards and certificates come later.

## Impact

No migration.
