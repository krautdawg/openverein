## Why

P3.10: clubs with Google Workspace, Microsoft or Nextcloud accounts want their board to sign in with those, instead of one more password.

## What Changes

- Admins set up issuer, client ID and client secret (stored encrypted), with a fresh second factor. The provider is checked before switching on.
- The sign-in page offers "Mit {Bezeichnung} anmelden": an authorization-code flow with PKCE, state and nonce, kept in a signed 10-minute cookie.
- Only existing, active accesses of the club sign in, matched by the provider's verified e-mail address.
- Accesses with a second factor still enter their code (the provider replaces only the password). Every sign-in and refusal is audited.

## Capabilities

### Modified Capabilities

- `platform`: OIDC sign-in.

## Impact

Migration `0061_oidc.sql`; new dependency `openid-client` 6.8.8; env `OIDC_ALLOW_HTTP` (development only).
