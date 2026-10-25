## Why

The full export builds a ZIP of every table and file inside the request. On a larger club that is slow, a closed tab loses it, and a proxy timeout turns a finished export into an error. The platform spec asks for long operations as jobs with a tray that shows progress.

## What Changes

- `job` table and an in-process worker (Postgres queue, `FOR UPDATE SKIP LOCKED`, stale claims retried once, then failed).
- The worker re-loads the starting user's account and grants before running; a deactivated user or a revoked grant fails the job.
- One active job per kind and club (partial unique index).
- `GET /jobs` (own jobs of the last 24 hours) and `GET /jobs/:id`.
- The full export becomes the first job: `POST /exports/full` answers 202 with the job; the job reports progress per table.
- Web: a job tray (bottom right) that appears while the user has recent jobs, shows progress and links to the result; it polls only while a job is active.

## Capabilities

### Modified Capabilities

- `platform`: job tray via polling, not server-sent events (see docs/decisions.md).

## Impact

Migration `0025_jobs.sql`. API change: `POST /exports/full` returns 202 and a job instead of 201 and the file.
