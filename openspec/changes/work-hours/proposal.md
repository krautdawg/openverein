## Why

P2.14: many clubs require work hours (Arbeitsstunden) per member and year and charge a substitute fee (Ersatzgeld) for missing hours. Today that runs on paper lists and manual invoices.

## What Changes

- Club rule: hours per year, substitute fee per missing hour, optional age range (age on 1 January as year minus birth year; unknown ages owe hours; organisations never).
- Hours are logged per member (date, hours in quarter steps, what for) by anyone with write access to that member, so division leads log for their division.
- Year overview per member: required, done, open, fee; in the caller's scope.
- "Ersatzgeld abrechnen": one draft invoice per member with missing hours (quantity = missing hours × rate, 0 % VAT), once per member and year (primary key); the treasurer reviews and issues them. Hours of a settled year can no longer be deleted.
- Page Mitglieder → Auswertungen → Arbeitsstunden with the rule as one sentence, the table and a sheet to log hours.

## Capabilities

### Modified Capabilities

- `members`: work hours. Exemptions per member and hours logged by members themselves in the portal come later.

## Impact

Migration `0031_work_hours.sql`.
