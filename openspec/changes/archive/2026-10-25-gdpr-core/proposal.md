## Why

A club has to answer access requests, honour withdrawn consents and erase data it no longer needs, without breaking its books. Slice 14 adds the GDPR core.

## What Changes

- Consent records per person and purpose (newsletter, photos, contact list, other) with source, text version, granted and withdrawn times; one live consent per purpose; withdrawing the newsletter consent unsubscribes the address, a fresh opt-in lifts the unsubscribe.
- Legal hold per person with reason.
- Anonymisation (step-up): refused with reasons while membership runs, invoices are open or in draft, a SEPA mandate is active or within 14 months of its last use, or a hold is set; otherwise removes name, address, contact data, notes, consents, deletable member files, change-request values, application payloads, mandate holder/IBAN and delivery addresses; issued invoices and receipts keep their snapshots.
- Erasure log with opaque ids in the database and in a file beside the stored files; at start-up the file is replayed so a restored older backup does not bring erased persons back.
- Access export (Art. 15): ZIP with `daten.json` and `auskunft.pdf` covering profile, memberships, groups, consents, invoices, mandates, donations, receipts, events, mails, change requests, applications, files and audit entries; audit-logged.
- Retention page: classes with period and legal basis, configurable erasure period after exit (default 24 months), review list of former members due with their blockers and an anonymise action.
- Member sheet: Datenschutz section.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `gdpr`: erasure log replay at start-up instead of `ovctl restore`; review list instead of a background job.

## Impact

Migration `0016_gdpr.sql`. Deferred (docs/decisions.md): automatic erasure mode, file-level retention review, importer payload purge, DPO/DPIA checklist hints, consent capture in the portal and application form, audit entries are not scrubbed.
