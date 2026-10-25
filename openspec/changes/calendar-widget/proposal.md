## Why

P29: club websites show upcoming dates (open training, matches, festivals) and today copy them by hand. easyVerein offers widgets; OpenVerein had only private ICS links.

## What Changes

- A calendar for all members can be made public. `GET /public/calendars/:id/events` (no sign-in, rate-limited) lists the next weeks' dates with title, time, all-day flag and place only: no description, no participants. Group calendars cannot be public.
- `/widget/termine/:id` is a plain page made for an iframe; the club lists the websites allowed to embed it (`frame-ancestors`), like the application form.
- The calendar sheet has the switch, the allowed websites and the embed code.

## Capabilities

### Modified Capabilities

- `events`: public calendar widget.

## Impact

Migration `0039_public_calendars.sql`.
