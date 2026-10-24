# auth Specification

## Purpose
The auth capability covers sign-in for admins, finance users and members: password login, sessions, TOTP that is mandatory for finance roles, e-mailed one-time codes for members and invitations (B M33, with the portal login rules of M29). Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour.

## Requirements
### Requirement: Password login
The system SHALL accept passwords of 12 to 128 characters, store them as Argon2id hashes, and reject any password found in the bundled breached-password list; an online k-anonymity check SHALL be optional and off by default.

#### Scenario: Short password rejected
- **WHEN** a user sets an 11-character password
- **THEN** the system rejects it with a message naming the 12-character minimum

#### Scenario: Breached password rejected
- **WHEN** a user sets a password that is in the bundled breached-password list
- **THEN** the system rejects it and asks for another one

### Requirement: Login without tenant code
The system SHALL sign users in with e-mail and credentials only and SHALL NOT ask for a club code.

#### Scenario: Plain login form
- **WHEN** a user opens the login page
- **THEN** the form asks only for e-mail and password (or a one-time code), not for a club code

### Requirement: TOTP mandatory for finance roles
The system SHALL require TOTP enrolment for any user holding write access to fees, invoices, SEPA, banking, ledger or donations, and for the tax-adviser and cash-auditor roles; the requirement SHALL be enforced at every login and on every request, not only at enrolment, and enrolment SHALL issue ten hashed single-use recovery codes.

#### Scenario: Finance role without TOTP
- **WHEN** a user is granted the Treasurer role and has not enrolled TOTP
- **THEN** finance write actions are refused until TOTP is enrolled

#### Scenario: TOTP checked at login
- **WHEN** a user with a finance role enters a correct password
- **THEN** the session is created only after a valid TOTP code or recovery code

#### Scenario: Recovery code is single-use
- **WHEN** a recovery code has been used once
- **THEN** using it again fails

### Requirement: Step-up TOTP for critical actions
The system SHALL require a TOTP confirmation from the last 10 minutes before generating a collection run, releasing a downloaded collection run, moving the lock date, issuing donation receipts, creating API tokens, changing roles and running the full data export.

#### Scenario: Stale second factor
- **WHEN** a treasurer whose last TOTP check was 25 minutes ago moves the lock date backwards
- **THEN** the system asks for a fresh TOTP code before applying the change

### Requirement: E-mailed one-time codes for members
The system SHALL let members sign in with a 6-digit code sent by e-mail that expires after 10 minutes and allows 5 attempts; the e-mail link SHALL only fill in the code and SHALL require a click (POST) to sign in, so that mail scanners prefetching links cannot consume it. Members MAY additionally set a password or passkey.

#### Scenario: Code expires
- **WHEN** a member enters a correct code 11 minutes after it was sent
- **THEN** sign-in fails and a new code can be requested

#### Scenario: Scanner-safe link
- **WHEN** a mail security scanner fetches the link in the code e-mail
- **THEN** the code is not consumed and the member can still sign in

#### Scenario: Attempts limited
- **WHEN** a wrong code is entered 5 times
- **THEN** the code is invalidated

### Requirement: Admin-issued sign-in code
The system SHALL let an admin issue a one-time code on a member's record so the member can sign in when the club's mail delivery fails, and SHALL audit-log each issued code.

#### Scenario: Code without mail
- **WHEN** an admin issues a code for a member whose e-mail bounced
- **THEN** the admin sees the code once and the event is written to the audit log

### Requirement: Rate limiting and lockout
The system SHALL rate-limit authentication endpoints per account and per IP and SHALL apply progressive lockout after 5 failed attempts, without any third-party captcha.

#### Scenario: Progressive backoff
- **WHEN** an account has 5 failed logins in a row
- **THEN** further attempts are delayed with increasing wait times

### Requirement: Sessions
The system SHALL keep sessions in the database, list a user's active sessions with a "sign out other sessions" action, and expire sessions after inactivity (admin 8 hours, portal 30 days); session cookies SHALL be `HttpOnly`, `Secure` and `SameSite=Lax` with CSRF protection on state-changing requests.

#### Scenario: Admin idle timeout
- **WHEN** an admin session has been idle for more than 8 hours
- **THEN** the next request requires a new login

#### Scenario: Sign out elsewhere
- **WHEN** a user chooses "sign out other sessions"
- **THEN** every other session of that user is invalidated immediately

### Requirement: Invitations
The system SHALL invite admins and members by e-mail with a single-use invitation that lets the invitee set up access; invitations SHALL expire and can be re-sent.

#### Scenario: Member invitation
- **WHEN** an admin sends a portal invitation to a member
- **THEN** the member receives an e-mail and can sign in with a one-time code from it

#### Scenario: Used invitation
- **WHEN** an invitation link that was already used is opened again
- **THEN** the system refuses it and offers the normal login

### Requirement: Authentication events are audited
The system SHALL write logins, logouts, failed logins, lockouts, TOTP enrolment and recovery-code use to the audit log.

#### Scenario: Failed login logged
- **WHEN** a login fails
- **THEN** an audit event records the account, the hashed IP and the time, without the attempted password
