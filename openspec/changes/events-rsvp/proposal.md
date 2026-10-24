## Why

Trainings, matches and board meetings are the heartbeat of a club. Slice 4 adds calendars, recurring events and RSVPs with capacity, waitlist, attendance and paid events, so clubs can plan without a second tool.

## What Changes

- Calendars with a court-line colour, visible to everyone or to selected groups; scoped trainers see only their calendars.
- Events with wall-clock times in the club's time zone, location, description, all-day flag, capacity, registration deadline, optional fee.
- Recurrence (daily, weekly on chosen weekdays, every n weeks, monthly) with until/count, exceptions, and edits or cancellations for "this", "this and following" or "all" occurrences; RSVPs move with split occurrences.
- Participations per occurrence: yes / maybe / no, waitlist with automatic promotion, attendance after the start; paid events issue one invoice per confirmed place.
- ICS subscription per calendar through a rotatable secret link.
- Birthdays overlay that respects the date-of-birth restriction.
- UI: month grid with court-line events, agenda list, occurrence sheet with RSVP and attendance, calendar management.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `events`: adds wall-clock time and recurrence-subset requirements.

## Impact

Migration `0006_events.sql`. No new dependencies (own RRULE subset and ICS writer, because `rrule` and `ical.js` fail the 90-day maintenance rule). Deferred (see `docs/decisions.md`): week and day views, ICS import, personal feeds (portal slice), mails for waitlist promotions (mail slice), weekly participation cap (could).
