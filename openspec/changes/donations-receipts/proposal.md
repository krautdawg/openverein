## Why

Donations are a main income of many clubs, and donors need a Zuwendungsbestätigung for their tax return. Slice 13 records money donations and issues single and collective receipts after the BMF template.

## What Changes

- Exemption data per club (Freistellungsbescheid or § 60a AO assessment, tax office, tax number, date, period, purposes, signer); receipts refused when missing or older than five / three years (§ 63 Abs. 5 AO).
- Money donations from members or new donors (name and address), optionally posted to the ledger (money account against a donation income account); waiver of expense refunds (Aufwandsspende) without posting.
- Receipts: single (one donation) or collective (several in one calendar year, with annex), numbered `ZB-YYYY-NNNN`, rendered once, stored with SHA-256 and template version, immutable in the database; cancel with reason, after which the donations can be receipted again; a donation is on at most one valid receipt (partial unique index).
- Annual run: one receipt per donor with open donations of the year; donors without address are listed, not blocking.
- Amount in words (German) for the receipt.
- Web: Spenden page with list, create sheet, receipts list with cancel, settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bookkeeping`: donations and receipts, money donations only for now.

## Impact

Migration `0015_donations.sql`, journal source `donation`. Deferred (docs/decisions.md): in-kind donations, receipts for membership fees, sending receipts by e-mail or the portal, bulk preview, simplified-proof note, signature image, purpose/sphere per donation.
