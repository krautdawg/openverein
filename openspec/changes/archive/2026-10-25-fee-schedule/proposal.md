## Why

X2 (should): easyVerein bills membership fees automatically, and treasurers forget runs without a reminder. OpenVerein keeps the mandatory preview but can create it on a schedule.

## What Changes

- Monthly schedule per club: on day 1 to 28, a preview of all periods that start within the next N days (default 30).
- It runs with the current rights of the person who set it up. That person needs club-wide fee and invoice rights and a personal account; if they are inactive or lost the rights, the run is skipped and an audit event is written.
- Each month is claimed before the run, so it happens once. An empty preview is not created.
- The person gets an e-mail with the link. Posting still needs a click.
- `GET`/`PUT /fee-schedule`; the fee runs page shows the "Automatische Vorschau" settings.

## Capabilities

### Modified Capabilities

- `fees`: scheduled fee-run preview.

## Impact

Migration `0048_fee_schedule.sql`. Runs inside the hourly refresh.
