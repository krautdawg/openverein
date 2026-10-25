# Decisions log

Small decisions made while building, especially where the spec was ambiguous or a blocker forced the conservative option. Larger stack decisions live in `docs/adr/`.

| Date | Decision | Reason |
|---|---|---|
| 2026-10-24 | Admin session idle timeout is 8 hours (Deliverable B M33), not 12 (Deliverable A §5.3). | The shorter value is the conservative one. |
| 2026-10-24 | Design direction chosen without an owner decision round ("sports hall floor": hall-blue rail, court-line group colours, one action colour). | Unattended build; the brief in PRODUCT.md and `.impeccable/surfaces/` records it so it can be re-rolled. |
| 2026-10-24 | Local ports: app 3300, Postgres 54329, Mailpit SMTP 11025 / UI 18025. | Avoid collisions with other services on developer machines. |
| 2026-10-24 | One address, one e-mail and one phone per person for now (spec asks for several with kinds). | Covers every current screen; a child table comes with households and invoice addresses in the fees slice. |
| 2026-10-24 | Custom fields, households, duplicate detection, saved views and XLSX export are deferred from slice 1. | They belong with the slices that need them (fees for households, import for duplicates); slice 1 stays reviewable. |
| 2026-10-24 | Bulk actions run synchronously (max 5,000 ids). | No job runner yet; background jobs arrive with the fee run. |
| 2026-10-24 | Member status refresh runs hourly, not nightly. | Same result, heals missed runs, no scheduler needed. |
| 2026-10-24 | API tokens cannot create users, roles or tokens. | A leaked key must not be able to create lasting access. Scripts that need to manage people can be revisited later with an explicit permission. |
| 2026-10-24 | An API token keeps working after the admin who created it is disabled. | Tokens belong to the club, not to a person; revoke them in Einstellungen → API-Schlüssel. |
| 2026-10-24 | PR #2 was reviewed by the third counsel rung (headless Claude, Opus) because Codex was out of quota and the Gemini CLI needs an interactive login. | Lead's rule: never skip the review. Run `agy` once interactively to restore the Gemini rung. |
| 2026-10-24 | Households, family discounts and credit-balance offset are deferred from the fees slice. | The fee engine and guards come first; households need the payer model and touch SEPA mandates (next slice). |
| 2026-10-24 | Proration is by months only (no day-based proration). | Matches how clubs bill; day proration can be added to the engine later. |
| 2026-10-24 | Recurring invoice templates and scheduled fee-run previews are deferred. | Need the job runner; manual runs cover the cycle. |
| 2026-10-24 | Payments and write-offs do not post journal entries yet. | The bookkeeping slice adds the journal and posts from allocations. |
| 2026-10-24 | Dunning levels are edited over the API only for now. | Defaults cover most clubs; a settings editor follows with the letter templates. |
| 2026-10-25 | IBAN change = new mandate with a new reference (no amendment info in pain.008). | Legally clean and simpler; amendment fields can follow if a pilot bank requires them. |
| 2026-10-25 | All recurrent collections use RCUR (one-off mandates OOFF). | Allowed since the November 2016 SEPA rulebook; avoids FRST tracking. |
| 2026-10-25 | Releasing a downloaded collection run needs an explicit "never submitted" confirmation, not yet TOTP. | TOTP arrives with the auth hardening slice; the confirmation is audited. |
| 2026-10-25 | Field encryption key from env `DATA_KEY` (HKDF-derived keys), not a Docker secret file with key escrow. | Same protection at rest with less ops; `ovctl`-style key handling is post-MVP. A fixed dev key is used only outside production. |
| 2026-10-25 | Bank fees and return-debit fees are recorded but not posted to a ledger. | The bookkeeping slice posts them. |
| 2026-10-25 | Rule 3 (batch credit = file control sum) only books for multi-item files on the same account with exactly one candidate. | A single member's transfer of the same amount must not settle a one-item file. |
| 2026-10-25 | Only the latest statement import of an account can be rolled back. | An older import may hold bookings that a later, overlapping import skipped as duplicates. |
| 2026-10-25 | Stored ciphertexts have no associated data (row binding). | Swapping ciphertexts needs database write access, which already allows worse; revisit with key rotation. |
| 2026-10-25 | PR #4 reviewed by the third counsel rung again (Codex quota out until 02:35, Gemini needs interactive login). | Lead's rule: never skip the review. |
| 2026-10-25 | Events: month and list views only (no week/day view yet); no ICS import; no personal feeds until the portal slice. | Covers planning; week/day views and imports follow when clubs ask. |
| 2026-10-25 | Own RRULE subset and ICS writer instead of `rrule` / `ical.js`. | Both libraries fail the 90-day maintenance rule; the subset we write is small and tested. |
| 2026-10-25 | Cancelling a paid event place keeps the invoice. | Refund or cancellation is the treasurer's decision. |
| 2026-10-25 | Events: no automatic waitlist promotion when capacity is raised; participant lists of club-wide events are visible to scoped trainers; ICS feeds use TZID without VTIMEZONE. | Review P3s of PR #5, deferred: rare cases, documented; revisit with the member portal. |
| 2026-10-25 | Mail composer is plain text with a fixed placeholder list (no rich text, no template engine). | Safe by construction (no code, no restricted fields); rich text later if clubs ask. |
| 2026-10-25 | Deferred from communication: free attachments (with documents slice), saved views as recipients, relay bounce webhooks, sender per purpose, "printed" status and PDF letter batches. | MVP sends the club's own documents; these extend it without schema changes. |
| 2026-10-25 | Mail delivery is at-least-once: a crash between the relay's acceptance and the status update resends that one mail. Login or sender refusals pause the whole queue until an admin resumes. | Losing mail is worse than a rare duplicate; pausing protects the address list from false bounces. |
| 2026-10-25 | Files on a local volume (`FILES_DIR`), no S3 backend yet; invoice PDFs stay on the invoice row. | Single-instance installs need no object store; the store interface is two functions, so S3 can slot in later. |
| 2026-10-25 | Vouchers are kept until 31 December of the 8th year after upload. | § 147 AO / § 257 HGB (8 years for Buchungsbelege since 2025); conservative because it counts from the upload year's end. |
| 2026-10-25 | A document is its whole version chain: place, retention class and legal hold change on all versions at once; old versions are read-only. | Review of PR #7: per-row state let a voucher expire and old versions leak across folders. |
| 2026-10-25 | File volume and database are backed up separately; restore both together. A bind-mounted `/data` must be writable by the container user `node` (uid 1000). | Documented for operators; named volumes get the right owner from the image. |
| 2026-10-25 | Portal identity is the e-mail address; self-only access is enforced in the API, without row-level security for now. | Matches how clubs register families; RLS adds operational weight before multi-tenant hosting needs it. |
| 2026-10-25 | Portal field rules are fixed (phone immediate; name, e-mail, address, IBAN need approval); per-group portal switches deferred (should). | Safe default; configuration when clubs ask. |
| 2026-10-25 | Online application forms ship as a separate PR (slice 7b). | Keeps reviews small; the portal works without them. |
| 2026-10-25 | Portal shares folders by their own flag only (no inheritance to subfolders); a returned debit does not re-arm a mandate amendment. | Review P3s of PR #8, deferred; the folder dialog states that the flag covers that folder. |
| 2026-10-25 | Application forms use fixed blocks; no custom fields, no e-mail double opt-in, no contact forms yet; the guardian is stored on the minor's record (contact e-mail, note, mandate account holder) rather than as a separate person. | Covers the common club case with little code; the debtor named in SEPA files is the guardian, never the minor. |
| 2026-10-25 | Applications: spam is deleted after 30 days, rejected applications are scrubbed after 6 months; IPs are not stored; confirmation mails go out directly (at most one per address and day, never to blocked addresses) rather than through the queue. | Data minimisation; the direct send keeps the confirmation immediate, the caps stop abuse. |
| 2026-10-25 | easyVerein import covers members, groups and mandates from CSV; fees, invoices, bookings, custom fields, XLSX, the API pull and the full export follow. The preset matches header names (UI labels, API names) and is unverified against a real export. | No real export file was available; every column stays mappable, so a different layout still imports. |
| 2026-10-25 | Mobile apps load the club's server URL (Capacitor `server.url`) instead of a bundled web build with a remote API. | Same bundle version as the web release, same cookies and CSRF rules; no CORS or token auth needed for the apps. |
| 2026-10-25 | Public demo locks user, role, API-key, upload and mail-server routes and uses a no-op mail transport. | Visitors share one admin account; nobody may lock others out, host files or send mail through the demo. |
| 2026-10-25 | Demo club has no households and no bookkeeping year yet. | Neither module exists; the seed grows with them. |
