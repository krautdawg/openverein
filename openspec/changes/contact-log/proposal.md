## Why

P06 (P2.4): calls, meetings and letters with members and sponsors stay in someone's head and are lost when the board changes.

## What Changes

- **Contact log per person:** kind (call, meeting, letter, e-mail, other), date (not in the future), note, an optional file kept with the member, and a "private" flag.
- **Visibility:** private entries are visible only to their author. Entries are only deletable by their author.
- **Access:** protected like the member note. Roles with the `note` field restricted get 403. Reading follows the member scope; adding and deleting need members write.
- **Audit:** the audit records that a note was made, not its text.
- **GDPR:** anonymising deletes the person's log. The Art. 15 export lists all entries, including private ones.
- **UI:** a "Kontaktverlauf" section in the member sheet.

## Capabilities

### Modified Capabilities

- `members`: contact log.

## Impact

Migration `0050_contact_log.sql`. The full export picks up the table (it has `organization_id`).
