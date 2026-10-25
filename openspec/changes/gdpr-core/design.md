## Decisions

- **Blockers first, in the same transaction.** The person row is locked, then the blockers are evaluated, so a parallel invoice or mandate either waits or is seen.
- **Snapshots carry the books.** Invoices, receipts and DATEV/Z3 exports already hold their own recipient snapshot; anonymisation never touches them.
- **Replay from a file.** A database restore also restores the database erasure log, so the authoritative copy is an append-only JSON-lines file in the files volume, read at start-up before the server listens.
- **Audit stays.** The audit log is append-only and kept for accountability; its diffs can contain personal data. Recorded as a known limit.
