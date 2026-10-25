## Why

P08 / P2.4: many statutes price fees by age (children, youth, adults). In OpenVerein this needed separate plans and reassignments at every birthday, and the easyVerein importer cannot carry age-driven fee formulas.

## What Changes

- **Brackets:** a plan version can carry age brackets (`upToAge`, `amountCents`, ascending, at most 10). Older members pay the version's amount.
- **Engine:** the member's age at the **start of each period** picks the amount. A birthday inside a period changes the amount from the next period. An individual amount wins; without a birth date the base amount applies.
- **Preview:** the birth date is part of the preview hash, so a changed birth date makes a preview stale.
- **Explanation:** "(Altersstufe bis 17 Jahre)".
- **Web:** the fee plan form edits the brackets, and the plan sheet shows them.

## Capabilities

### Modified Capabilities

- `fees`: age brackets.

## Impact

Migration `0054_age_brackets.sql` (`fee_plan_version.age_brackets`, default empty).
