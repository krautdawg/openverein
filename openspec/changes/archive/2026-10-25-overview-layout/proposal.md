## Why

P22: the overview should fit each person's role, for example the treasurer without "Erste Schritte" and with the tasks first.

## What Changes

- Each access orders and hides the overview sections (figures, change requests, tasks, first steps). It is stored per access (`app_user.overview_layout`) and returned with `/auth/me`.
- `PUT /auth/me/overview` stores the layout. Unknown sections are refused.
- On the overview, "Übersicht anpassen" opens a panel with show/hide checkboxes and up/down buttons, all usable by keyboard.

## Capabilities

### Modified Capabilities

- `platform`: per-user overview layout.

## Impact

Migration `0060_overview_layout.sql`.
