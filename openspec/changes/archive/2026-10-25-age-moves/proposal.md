## Why

Youth members move to adult groups at a set age (P07, Phase 2 before cancellation): easyVerein does this through `nextGroup`, and the importer cannot carry it. Without a rule, someone has to remember every 18th birthday.

## What Changes

- Group rule: target group, age, and timing (birthday or 1 January of the year the age is reached). All three or none (database check), not the group itself.
- Hourly with the status refresh: due members leave the group yesterday and join the target today (history is not backdated). Members added to the group after reaching the age are left alone. Audit event per move as System.
- Preview `GET /groups/:id/age-moves` for the next 12 months (overdue included), scoped, and only for users who may see birth dates.
- Group sheet: the rule as one sentence ("Mit 18 Jahren am Geburtstag wechseln nach …") and the list of upcoming moves.

## Capabilities

### Modified Capabilities

- `groups-and-roles`: age rule. Fee-assignment proposals on a move and age-based fee formulas (P08) come later.

## Impact

Migration `0028_age_moves.sql`.
