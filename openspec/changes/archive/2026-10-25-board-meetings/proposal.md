## Why

P2.9 asks for basic meetings and minutes. Board meetings need the same record as general assemblies (agenda, invitation, attendance, decisions, minutes) but go to one group.

## What Changes

- Assemblies get a kind: general assembly or board meeting. A board meeting is invited to one group (default: the group of kind "Vorstand"), with its own default agenda and a 7-day default notice; its eligible count is that group's members on the day; the attendance list shows that group.
- Adds the missing end-to-end test for general assemblies (it was announced in #46 but not in the repository).

## Capabilities

### Modified Capabilities

- `communication`: board meetings.

## Impact

Migration `0035_board_meetings.sql`.
