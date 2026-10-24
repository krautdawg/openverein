## Context

Deliverable A specifies a pure fee engine, an exclusion constraint against double billing, Typst for PDFs and pg-boss jobs for long runs.

## Goals / Non-Goals

**Goals:** correct money paths first: preview before posting, stale-preview detection, database-enforced guards, immutable issued documents, reproducible PDFs.

**Non-Goals:** households, credit balances, background jobs, journal postings (bookkeeping slice), mail delivery (communication slice).

## Decisions

- **Engine walks periods with a cursor.** At each step it takes the price version valid at the cursor, finds the period of that version's interval that contains the cursor (calendar grid from 1 January, or counted from the first period start), subtracts days already billed in the same charge slot, and prorates by months touched when the period is partial. Interval changes and price changes fall out of the same loop.
- **Preview hash per member.** The hash covers assignments, price versions, billed ranges, exit date, payment method and the cut-off. Posting recomputes it; any difference returns 409 "Daten haben sich seit der Vorschau geändert".
- **Charge slots.** `main` for the main plan, `plan:<id>` for add-ons, `admission:<id>` for admission fees. The exclusion constraint works per slot.
- **One transaction per run.** Simpler than resumable chunks and correct at club scale; marked `shortcut:` in code with the upgrade path (chunked jobs above about 2,000 members).
- **PDF with pdfkit + lean-qr instead of Typst** (ADR 0002): no binary in the image. Source Sans 3 TTF embedded so names like "Yılmaz" render. The issue transaction freezes recipient and letterhead into `invoice.recipient`; the PDF is rendered from that snapshot on first download and stored; the trigger refuses a second write, so every download returns the same bytes.
- **Cancellation documents** have their own range (`S-{YYYY}-{seq:5}`) and status `issued`; the original becomes `cancelled` and its assessments are freed. Cancelling is refused while payments are allocated.
- **Payments are allocations.** `paid_cents` and status are recomputed from confirmed allocations; a write-off is an allocation of kind `write_off`; reversal flips an allocation to `reversed`.

## Risks / Trade-offs

- [Lazy PDF rendering] → content still comes from the issue-time snapshot, so a later letterhead change cannot alter an issued document (tested).
- [Month proration rounds to cents per line] → sums of split periods can differ by a cent from a full period; proration only applies to partial periods.
- [Synchronous posting] → long runs block one request; acceptable below ~2,000 members.
