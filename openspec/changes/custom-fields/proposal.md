## Why

Every club needs a few extra fields (shirt size, licence date, allergies). The members spec asks for custom fields with types, required flag, sensitivity and use in lists, exports and mails.

## What Changes

- Field definitions per club: key, label, type (text, multiline, number, date, checkbox, select, multiselect), options, required, position, member flags (stored for the portal), sensitive, archive.
- Values in `person.custom` by field id; validated per type; required on new members (not on imports); sensitive fields only for club-wide readers, never in mails, and kept out of the audit log values.
- Type locked once values exist; options in use cannot be removed; deleting a field with values needs its name typed, removes the values and is audited.
- Member detail and patch with values, list filter `cf=<id>:<value>`, CSV export columns, mail placeholders `{{custom.key}}` (and chips in the composer).
- Web: Einstellungen → Felder; "Weitere Angaben" in the member sheet; required fields in the create sheet.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `members`: file-type fields, portal display/editing, import targets and a list filter UI come later.

## Impact

Migration `0018_custom_fields.sql`.
