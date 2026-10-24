# Decisions log

Small decisions made while building, especially where the spec was ambiguous or a blocker forced the conservative option. Larger stack decisions live in `docs/adr/`.

| Date | Decision | Reason |
|---|---|---|
| 2026-10-24 | Admin session idle timeout is 8 hours (Deliverable B M33), not 12 (Deliverable A §5.3). | The shorter value is the conservative one. |
| 2026-10-24 | Design direction chosen without an owner decision round ("sports hall floor": hall-blue rail, court-line group colours, one action colour). | Unattended build; the brief in PRODUCT.md and `.impeccable/surfaces/` records it so it can be re-rolled. |
| 2026-10-24 | Local ports: app 3300, Postgres 54329, Mailpit SMTP 11025 / UI 18025. | Avoid collisions with other services on developer machines. |
