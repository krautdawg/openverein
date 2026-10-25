## Why

P10 (P2.4): the honours list (#41) showed who to honour, but greetings were not sent and awarded honours were not recorded.

## What Changes

- **Greeting mails (opt-in per club):**
  - Birthdays: off, round birthdays or every birthday.
  - Membership anniversaries: from 10 years, every 5 years.
  - Sent on the day to active members with an e-mail address, never to blocked addresses.
  - Each greeting is claimed in `greeting_sent` before sending, so it goes out at most once per person, kind and year.
  - Two editable system texts with the placeholder `{{jahre}}`.
- **Honours register:** title, date and decision per member, recorded and removed from the "Ehrungen" page (anniversaries only). The awarded honours of the year are listed there.
- **Shared rules:** the honour and birthday rules (`src/shared/honours.ts`) are shared by the report and the greetings.

## Capabilities

### Modified Capabilities

- `members`: greetings and honours register.

## Impact

Migration `0053_greetings_honours.sql`. The greeting run is part of the hourly refresh.
