## Decisions

- **The e-mail address is the portal identity.** Clubs register children under a parent's address; one sign-in shows every current membership under that address. Admins editing an address change who sees what, which matches how clubs already think about contact addresses.
- **Separate session table and cookie** (`ov_portal`). Portal sessions never reach the admin API (`actorFromRequest` ignores them), and admin grants never apply in the portal.
- **Codes are hashed with their row id**; at most three per address and hour; the per-IP limit stops sweeping. Requesting a code answers the same for unknown addresses.
- **Change requests store IBANs encrypted** and show only the last four digits to admins with the IBAN right.
- **Mandate amendment** is a flag on the mandate plus the previous IBAN. The first debit run carries it (`collection_item.carries_amendment`); releasing that run hands it back to the mandate.
