## Why

P25 (P3.6): board follow-ups get lost between meetings. Assemblies, minutes and polls exist; tasks were missing.

## What Changes

- **Tasks:** title, note, due date, assignee (an active user) and an optional linked member.
- **Access:** every user of the club sees and creates tasks. The creator, the assignee and administrators edit or complete them; the creator and administrators delete them.
- **Member link:** a linked member is named only to users who may read that member.
- **Mail:** the assignee gets an e-mail when someone else assigns the task.
- **Web:** an "Aufgaben" page (Offen / Meine / Erledigt) and "Deine Aufgaben" on the overview.

## Capabilities

### New Capabilities

- `club-operations`: tasks.

## Impact

Migration `0052_tasks.sql`.
