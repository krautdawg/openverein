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
