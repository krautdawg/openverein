## Why

Most new members find a club online. Slice 7b lets clubs publish an application form (link, iframe, QR code) and turn a submission into a member with groups, fee and mandate in one step.

## What Changes

- Application forms with offered groups and fee plans, optional SEPA mandate, versioned consent text, privacy link, allowed embedding origins; public page `/aufnahme/<slug>` with `frame-ancestors` limited to those origins; QR code and iframe snippet in settings.
- Spam protection without third parties: honeypot, signed form token with a minimum fill time of 3 seconds and a 24-hour lifetime, per-IP rate limit. Bot submissions are stored as spam, never shown as new.
- Immutable submissions (trigger) with consent text and version, hashed IP; confirmation mail with a PDF copy (mandate text and signature line when the mandate waits for paper).
- Board inbox `/antraege`: details, duplicate check (same e-mail and first name, or same name and birth date), accept (person, member, groups, fee assignment, mandate in one transaction), reject with a mailed reason, mark as spam singly or in bulk.
- Club rules: join date rule (application day, acceptance day, first of the application month, first of the next month) and whether the bank allows online mandates (else `pending_evidence`).
- Minors: guardian data required; the mandate's account holder must not be the minor; mails go to the guardian.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `member-portal`: fixed form blocks for the MVP.

## Impact

Migration `0010_applications.sql`. No new dependencies. `insertMember` and `insertMandate` extracted for reuse. Deferred (docs/decisions.md): custom fields, e-mail double opt-in, contact forms (could), guardian as separate person record.
