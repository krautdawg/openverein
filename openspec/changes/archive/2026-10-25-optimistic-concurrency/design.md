## Decisions

- **Honoured, not required (yet).** Requiring If-Match on every PATCH would break existing clients and every PATCH route at once; the three most edited resources honour it now, and the web client always sends it there.
- **Timestamps as versions.** `updated_at` is already maintained on every write; the version joins the member's and the person's stamps, so a change to either is detected.
