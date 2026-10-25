## Why

The platform spec asks for WCAG 2.2 AA. Until now that was checked by eye per slice. An automated audit on every route keeps it from regressing.

## What Changes

- Playwright spec runs axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on every admin route, the sign-in page, the portal sign-in and an open member sheet. Serious or critical findings fail CI.
- Keyboard pass: skip link first, it becomes visible on focus and moves focus to the content; the command palette opens, runs and closes from the keyboard.
- Fixes found by the audit: kbd hint contrast in the rail, 24px minimum target for placeholder buttons, the month calendar's weekday heads (no orphan column headers; each day names its weekday to screen readers), visible skip link.

## Capabilities

### Modified Capabilities

- `platform`: accessibility is now tested in CI.

## Impact

Dev dependency `@axe-core/playwright`.
