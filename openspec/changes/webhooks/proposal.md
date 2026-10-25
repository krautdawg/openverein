## Why

P29 / P3.4: club websites and tools need to know when members, events or invoices change. Polling the API is wasteful; easyVerein has no webhooks at all.

## What Changes

- Webhooks per club: https URL, topics (member, person, group, household, application, event, invoice, donation, assembly), on/off.
- Outbox: a trigger on the audit log queues a delivery for every audited change of a subscribed topic in the same transaction, so a change is never lost and never announced when it rolled back.
- Worker every 5 s: POST with `X-OpenVerein-Event`, `-Delivery`, `-Timestamp` and `-Signature` (`sha256=` HMAC of timestamp, dot and body with the per-webhook secret, shown once); retries after 1, 5, 30, 120 and 720 minutes, then failed. Redirects are not followed; private, loopback and link-local targets and plain http are refused (development switch `WEBHOOKS_ALLOW_PRIVATE`).
- Payloads carry event, entity type, id and time only; receivers read details through the API with their own token, so field restrictions keep applying.
- Settings → Webhooks with deliveries and a test event. Locked in the public demo; secrets are dropped from the full export.

## Capabilities

### Modified Capabilities

- `api`: outbound webhooks. Website widgets come later.

## Impact

Migration `0037_webhooks.sql`.
