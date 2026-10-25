## Why

A club without a technical volunteer must be able to install, back up, restore and update the server. Until now there was only the development compose file.

## What Changes

- `deploy/compose.yml` for production: Caddy (automatic HTTPS, HSTS), app, Postgres 18; fixed network so only Caddy is a trusted proxy; required settings fail fast.
- `ovctl install | backup | restore | update | doctor | logs`.
  - install writes `deploy/.env` (mode 600) with a generated database password and DATA_KEY.
  - backup: pg_dump + files tar + SHA256SUMS, rotated after 14.
  - restore: verifies sums, backs up first, keeps and merges the current erasure log so erased persons stay erased.
  - update: backup first.
  - doctor: services, health, DATA_KEY, disk, backup age, certificate.
- CI runs shellcheck.

## Capabilities

### Modified Capabilities

- `platform`: operations tooling; off-site copy and restore drill are documented, not built in.

## Impact

New files only; docs/operations.md and README.
