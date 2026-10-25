## Why

Trainers take attendance in sports halls, often without mobile signal. Until now, a lost connection meant an error, and the trainer had to remember the marks.

## What Changes

- If the connection is lost while attendance is marked, the mark is kept on the device (localStorage), shown at once, and announced in a status banner.
- Waiting marks are sent when the browser is back online, and every 30 seconds. Setting a status is idempotent.
- A mark the server refuses stays visible with its reason until someone discards it.

## Capabilities

### Modified Capabilities

- `events`: offline attendance.

## Impact

Web only: `src/web/lib/offlineAttendance.ts`, the occurrence sheet and the shell. No server change.
