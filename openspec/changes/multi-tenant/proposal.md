## Why

P2.11: clubs without a technical volunteer need hosting by an operator; one installation should serve several clubs.

## What Changes

- `MULTI_TENANT=true`: clubs are reached under their own host names (`organization.hostname`); links in mails use them.
- Operator API (`/api/v1/operator/tenants`, header `X-Operator-Token`): list, create (club, host name, first admin with an invitation), rename or move host.
- The open setup is closed; an access signs in only on its own club's host name; the portal signs members in for the club of the host name.
- The mail queue runs per club with its own rate and pause switch.

## Capabilities

### Modified Capabilities

- `platform`: managed hosting.

## Impact

Migration `0059_tenant_hostname.sql`; new env `MULTI_TENANT`, `OPERATOR_TOKEN`.
