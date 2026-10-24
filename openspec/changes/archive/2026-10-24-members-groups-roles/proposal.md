## Why

A club tool is useless without its members. Slice 1 delivers the member register with dated lifecycle, groups with dated membership, and the role model that decides who may see and change what, so that division leads and trainers can use the tool safely from day one, and so that scripts and the sister agent project can do the same over the API.

## What Changes

- Persons and members: one record per member (natural person or organisation), member numbers from a configurable pattern, lifecycle `applicant → future/active → resigned → former` (and `rejected`) changed only through dated actions, nightly date-driven status changes in the club's time zone, notice rule with proposed exit date, former members hidden by default.
- Member list: search with typo and umlaut tolerance, status views, group filter, cursor pagination, CSV export with formula escaping, bulk add/end group membership with per-record results.
- Groups: kinds, unique short codes, court-line colours, one level of parents, admin-only flag, dated memberships without overlaps (database exclusion constraint), "who was in the group on date X".
- Roles: seven built-in roles (immutable), custom roles, grants scoped to groups, field restrictions (IBAN, notes, date of birth, e-mail, phone), "check permissions" view, last-admin protection, invitations by single-use link.
- API tokens bound to one role (and optional group scope), shown once, hashed, revocable, audited under their name; tokens cannot mint tokens.
- Audit log view with filters; overview figures from real data.
- UI: members list with side sheet (inline editing, status actions, group history drawn as court lines), groups page, settings tabs (club, users, roles, API keys, audit log), invitation page, member search in the command palette.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `members`: adds the concrete member-list search and keyboard requirements built in this slice.
- `groups-and-roles`: adds invitation and last-admin protection requirements.
- `api`: adds the rule that API tokens cannot create tokens.

## Impact

Migrations `0002_members_groups_roles.sql` (btree_gist, pg_trgm) and `0003_unaccent.sql`. New routes under `/api/v1/members`, `/groups`, `/group-memberships`, `/roles`, `/users`, `/api-tokens`, `/audit-events`, `/overview`. Deferred to later slices and recorded in `docs/decisions.md`: custom fields, households, duplicate detection, several addresses per person, saved views, XLSX export, background jobs for large bulk actions.
