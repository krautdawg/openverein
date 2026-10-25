## Decisions

- **Generic over hand-written.** Tables are discovered from the schema (`organization_id` column) plus a short list of child tables, so new tables are exported without code changes; a deny-list removes secrets.
- **Built in memory.** Club sizes keep the ZIP small enough; the existing ZIP writer is reused. A streaming writer is the upgrade path for very large file stores.
