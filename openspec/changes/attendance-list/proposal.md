## Why

P04: municipal and sports-federation grants (for example Übungsleiterzuschuss) need attendance lists per group and period. Attendance was recorded per session but could not be exported.

## What Changes

- `GET /calendars/:id/attendance.csv?from&to` (at most one year) gives one row per member and one column per session, with "x" for present, a total per member and per session.
- Only members the user may read are included. A trainer gets their own group.
- Cells that look like formulas are neutralised.
- The calendar sheet links "Anwesenheit {Jahr}" for each calendar.
- Offline capture in the PWA (also P04) stays open.

## Capabilities

### Modified Capabilities

- `events`: attendance export.

## Impact

No migration.
