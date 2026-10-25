## Why

Managed hosting (#89) can create clubs, but when a club leaves, the AVV template (section 6) promises a handover of the full export and then deletion. Until now that needed manual SQL across 80+ tables, against triggers that forbid deleting issued invoices and journal entries.

## What Changes

- `GET /operator/tenants/:id/export.zip` returns the club's full export, for the operator to hand over.
- `DELETE /operator/tenants/:id` with `confirmHostname` deletes the club and every row it owns, and returns the counts per table. It needs a superuser connection: the immutability triggers are lifted only for that one transaction. Every foreign key is then verified, and the deletion rolls back on any dangling reference.

## Capabilities

### Modified Capabilities

- `platform`: operator can hand over and delete a club.

## Impact

No migration. `CHILDREN` in `exports/full.ts` is exported for reuse. Docs: operations.md, decisions.md.
