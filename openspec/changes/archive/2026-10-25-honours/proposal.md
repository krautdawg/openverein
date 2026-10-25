## Why

P2.4 asks for birthday and anniversary lists with greeting mails. Every club honours long-standing members at the general assembly and sends birthday greetings; today that is a spreadsheet exercise.

## What Changes

- `GET /reports/honours?year=`: current members' membership anniversaries (10 years and every 5 after) and round birthdays (18, 30, 40, 50, 60, 65, 70, 75, 80, 85, 90, 95, 100+), sorted by date; 29 February falls on 28 February in other years. Scoped; birthdays only with the birth-date right.
- Page Mitglieder → Auswertungen → Ehrungen with a year choice and "E-Mail an alle" into the composer. Bestandserhebung and Ehrungen share a tab bar; the members header shows one "Auswertungen" link.

## Capabilities

### Modified Capabilities

- `members`: honours lists. Configurable anniversary steps and a contact log per person come later.

## Impact

No migration.
