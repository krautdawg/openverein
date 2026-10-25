## Why

P2.2: clubs moving from Google or Outlook calendars, or receiving hall schedules as ICS, had to type events by hand. The ICS feed already exists; ICS import was missing.

## What Changes

- `POST /calendars/:id/import` takes an ICS file (up to 2 MB, up to 2,000 events) into a writable calendar.
- **Parser** (`src/server/events/icsImport.ts`, RFC 5545 subset):
  - Unfolding and text unescaping.
  - Times: floating, TZID (converted into the club's zone) and UTC; all-day events with exclusive DTEND; DURATION.
  - EXDATE is kept.
  - RRULE only in the subset OpenVerein repeats exactly. Others import the first date and report it.
  - Cancelled events and single changes to a series are skipped and reported.
- **Duplicates:** the UID is stored in `event.import_uid`, so importing the same file again adds nothing.
- **RSVP:** imported events have sign-up switched off.
- **Web:** "ICS importieren" for each calendar in the calendar sheet.

## Capabilities

### Modified Capabilities

- `events`: ICS import.

## Impact

Migration `0055_ics_import.sql`.
