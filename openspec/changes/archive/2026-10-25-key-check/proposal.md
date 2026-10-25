## Why

Risk register: "The master key is lost, so every IBAN, TOTP secret and backup is unreadable" and "A failed unattended upgrade strands the only copy of a club's books". A server started with the wrong DATA_KEY (new server, restored backup, lost .env) currently runs and writes new bank details with a second key, mixing two keys in one database. A failed update gave no way back.

## What Changes

- The database stores a keyed fingerprint of DATA_KEY on first start (`instance_setting`); a later start with a different key stops with a German message before accepting requests.
- `ovctl update`: if the new version does not come up healthy, it prints the two commands to roll back code and data together (never old code on a migrated database).
- The fingerprint is installation data and not part of the club's full export.

## Capabilities

### Modified Capabilities

- `platform`: key check and update rollback guidance.

## Impact

Migration `0034_instance.sql`. Existing installations store the fingerprint on their next start.
