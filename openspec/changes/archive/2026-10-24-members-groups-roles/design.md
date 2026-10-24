## Context

Deliverable A asks for a policy module (`can`, `scopeQuery`, `project`) used by UI, API and exports, plus RLS as a second line. Slice 0 has one organisation per install and no RLS.

## Goals / Non-Goals

**Goals:** one policy module that every route uses; scope and field restrictions enforced on the server for UI, API, CSV and audit diffs; dated data stays correct at midnight in Europe/Berlin.

**Non-Goals:** RLS (comes with multi-tenant hosting), custom fields, households, saved views, XLSX, background jobs.

## Decisions

- **Actor model.** Every request resolves to an `Actor` (user or API token) with its grants. `level`, `requirePermission`, `scopeOf` and `restrictedFields` in `src/server/policy.ts` are the only places that decide access.
- **Scope as SQL.** A scoped grant sees members with a current membership in one of its groups (or one ended within 12 months, read only). The predicate is a single `exists` subquery applied by `applyScope` to every member query; out-of-scope records answer 404.
- **Field restrictions = intersection.** A field is hidden only if every grant that can read members hides it, so Admin + Trainer still sees everything. Hidden fields are omitted from responses and CSV columns, refused on write (403) and masked in audit diffs at read time.
- **Status is derived by actions, stored, and refreshed hourly.** `refreshMemberStatuses` moves `future → active` and `resigned → former` using `now() at time zone organization.time_zone`, and audits each change as System. Hourly instead of nightly costs nothing and heals missed runs.
- **Exclusion constraint** on `group_membership (member_id, group_id, daterange)` makes overlapping spells impossible regardless of code paths.
- **Search** uses `unaccent` + `word_similarity` (pg_trgm) on the full name; cheap at club scale (< 10,000 rows) without a search index.
- **Cursor = opaque offset** for now (`shortcut` comment in code); keyset pagination when lists get large.
- **Invitations** are single-use tokens (SHA-256 stored, 7 days) delivered as a link the admin copies; the mail slice will send them.

## Risks / Trade-offs

- [Offset cursor can skip/duplicate rows when data changes between pages] → acceptable for UI paging at club scale; noted in code.
- [No RLS] → all member queries go through `applyScope`; tests cover lead/trainer/tax adviser paths.
- [Bulk actions run synchronously] → limited to 5,000 ids per call; jobs arrive with the fee run slice.
