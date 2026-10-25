## ADDED Requirements

### Requirement: Secrets never leave in a full export
The system SHALL leave sessions, sign-in codes, recovery codes, password and token hashes, TOTP secrets and keyed lookup hashes out of every full export.

#### Scenario: App users exported
- **WHEN** a full export is created
- **THEN** `data/app_user.jsonl` contains names and e-mail addresses but no password hash and no TOTP secret
