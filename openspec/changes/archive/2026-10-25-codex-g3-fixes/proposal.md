## Why

The Codex review of #5 to #7 (documents, events, mail) found stale authorization, a lifecycle inferred from the upload time, file names in logged URLs, and races in mailing.

## What Changes

- Temporary files expire seven days after they became temporary (`file.temporary_since`, set by a trigger).
- New versions, changes and deletions of files authorize the locked current row; event edits, cancellations and RSVPs lock the event and authorize its current calendar.
- Upload file names travel in the `X-File-Name` header (percent-encoded); the query parameter remains only as a fallback.
- The mail worker skips a delivery whose address was corrected after queueing; invoice mailings are serialized; the per-minute rate is reserved under the club's row lock.
- A single occurrence cannot take a new rule.

## Capabilities

### Modified Capabilities

- `documents`: upload names in a header.

## Impact

Migration `0057_file_temporary_since.sql`.
