## 1. Data model

- [x] 1.1 Migration: number_sequence, person, member, club_group, group_membership (exclusion constraint), role (immutable built-ins), role_grant, api_token, invitations, organisation notice rule
- [x] 1.2 unaccent for search

## 2. Policy and auth

- [x] 2.1 Actor model for users and API tokens; policy module (level, scope, restricted fields)
- [x] 2.2 Built-in roles seeded at setup; invitation accept endpoint

## 3. API

- [x] 3.1 Members: list/search/filter/cursor, detail with history, create, patch, resign, withdraw, admit, reject, exit proposal, CSV export, bulk
- [x] 3.2 Groups and dated memberships, members on a date
- [x] 3.3 Roles, users, effective permissions, API tokens, audit events, overview
- [x] 3.4 Hourly status refresh in the club time zone

## 4. Web

- [x] 4.1 Members list, side sheet with inline edit, status actions and court-line group history, create sheet, bulk bar
- [x] 4.2 Groups page and sheet
- [x] 4.3 Settings tabs: club, users, roles, API keys, audit log; invitation page
- [x] 4.4 Overview figures and checklist; member search in the command palette

## 5. Verification

- [x] 5.1 Integration tests: numbering, statuses, transitions, search, CSV, groups, scope, field restrictions, roles, invitations, tokens
- [x] 5.2 Playwright: create group, create member, find by palette, resign
