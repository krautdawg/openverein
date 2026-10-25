## Decisions

- **Immutability in the database.** A trigger refuses any change to an issued receipt except the one-time cancellation, and refuses deletes; donations on a valid receipt cannot be changed or deleted.
- **Valid-once by index.** `donation_receipt_item.live` with a partial unique index guarantees a donation is on one valid receipt; cancelling flips `live` so the donation can be receipted again.
- **Wording.** The PDF follows the BMF template text for money donations to § 5 Abs. 1 Nr. 9 KStG bodies; `RECEIPT_TEMPLATE` names the version stored on each receipt. The text must be checked against the current BMF letter before production use.
- **Posting optional.** Many donations arrive by bank transfer and are already in the ledger through reconciliation; the form offers "Nicht buchen" for those.
