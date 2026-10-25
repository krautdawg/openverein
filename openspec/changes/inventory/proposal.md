## Why

P3.6: clubs own balls, kits, tents and a beamer, and lose track of who has what. Lists live on paper in the equipment room.

## What Changes

- Inventory items (name, category, place, inventory number, count, value, note); retired instead of deleted, not while lent.
- Loans to members with count, date and optional due date; never more than available (row lock); overdue loans are marked; returns are recorded.
- Dokumente gets a tab bar: Dateien, Inventar.

## Capabilities

### Modified Capabilities

- `documents`: inventory and lending. Reminders for overdue loans and lending in the portal come later.

## Impact

Migration `0041_inventory.sql`.
