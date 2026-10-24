## Decisions

- **Wall-clock times.** Events store `timestamp without time zone` in the club's zone; a training at 18:00 stays at 18:00 across daylight-saving changes. Feeds publish `TZID=<club zone>`.
- **Own RRULE subset.** OpenVerein only writes FREQ=DAILY/WEEKLY/MONTHLY with INTERVAL, BYDAY, UNTIL or COUNT; the expander is ~60 lines with tests. External ICS import (which needs full RRULE) is deferred.
- **Occurrences are computed, not stored.** Participations key on (event, occurrence date). "This" turns the date into an exception plus a single event; "following" ends the series the day before and starts a new one; participations move along.
- **Capacity under concurrency.** RSVP changes take a per-occurrence advisory lock, so two last places cannot both be taken; a freed place promotes the earliest waitlisted member.
- **Paid events** create and issue an invoice for the first confirmed place per member and occurrence; cancelling does not refund automatically (treasurer decides).

## Risks / Trade-offs

- [Edits to a series after a "following" split affect only one part] → the UI states which part is edited.
- [Browser time used for the "started" hint] → the server enforces with the club's time.
