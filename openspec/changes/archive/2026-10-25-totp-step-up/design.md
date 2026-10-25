## Decisions

- **Own TOTP, tested against the RFC vectors.** Thirty lines with `node:crypto`; no library needed.
- **Ticket instead of a half session.** The password step returns a signed ticket (user id, expiry, HMAC with the derived key); only the code step creates a session, which records `mfa_at`.
- **Enforcement in `requirePermission`.** Finance modules check the second factor on every request, so no route can forget it. `requireStepUp` is a one-line call on critical routes.
- **Step-up in the client.** `api()` retries once after the step-up prompt resolves, so pages need no special code.
- **Pending secret.** Setup stores the new secret marked pending; the old factor stays active until a code for the new one is confirmed.
