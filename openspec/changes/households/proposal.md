## Why

Families are billed together: one invoice to the parent who pays, collected with that parent's mandate, often with a family discount. The members spec asks for households with a payer and an effective-dated discount rule.

## What Changes

- Households with name, payer (any person of the club) and members (a member is in at most one household).
- Effective-dated discount rules: none, percent from the n-th member (highest fee pays in full), cap per run, children (under 18 on the issue date) free from the n-th child; applied to membership fees (main slot) only.
- Fee runs: preview lists households with payer, members, rule and discount; posting creates one invoice per household to the payer with one line per member and fee plus a discount line; a changed payer, member set, birth date or rule makes the preview stale. Discount lines are the only negative invoice lines.
- Removing the payer's own membership from the household needs a new payer first.
- Web: Mitglieder → Haushalte (list, create sheet, household sheet with members, payer, rules, dissolve); fee run detail shows households and adjusts totals.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `members`: no billing address override yet; the household invoice carries the anchor member's number and payment method (payer's own membership, else the first member).

## Impact

Migration `0019_households.sql` (households, rules, `member.household_id`, `invoice_line.discount`).
