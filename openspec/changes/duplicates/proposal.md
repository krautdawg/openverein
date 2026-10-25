## Why

Imports and years of manual entry leave persons recorded twice. The members spec asks for scored duplicate detection with remembered dismissals and archiving of the copy without financial records.

## What Changes

- Scored pairs (0–100): name similarity up to 50 (German spellings ü/ue, ö/oe, ä/ae, ß/ss compare equal), birth date 20, e-mail 15, IBAN (mandate hash) 10, address 5; threshold 60–100 %.
- "Not a duplicate" remembered per pair; resolving also remembers the pair.
- Archive the duplicate when it has no invoices, mandates, donations, collection items, fee assessments or household payer role: the person is archived, an ongoing membership ends today with the reason "Dublette von Nr. …".
- Web: Mitglieder → Dubletten with threshold slider, highlighted matching fields, actions per pair.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `members`: no automatic check during import yet (on demand only); no merging of records.

## Impact

Migration `0021_duplicates.sql`.
