# platform Specification

## Purpose
The platform capability covers the app shell, the German-first UI that addresses users with "Du", accessibility at WCAG 2.2 AA, the fixed dashboard (B M40), the background job tray (B M41), the self-ticking first-run checklist, the public demo mode and self-hosted operations (B M42), and mobile builds that wrap the web build with Capacitor. Items that B rates "should" or "could" are marked as such in the requirement name; everything else is MVP behaviour, including the demo mode.
## Requirements
### Requirement: Single app shell on the public API
The system SHALL serve one web application with an admin route tree and a separate `/portal` route tree, both built on the same public REST API, with a header that holds global search, the job tray and the user menu.

#### Scenario: Portal and admin share the API
- **WHEN** an admin action is performed in the UI
- **THEN** it is executed through a documented `/api/v1` endpoint and no private UI-only endpoint exists

### Requirement: German-first UI addressing users with "Du"
The system SHALL ship German as the default locale, address users with the informal "Du" in all UI text, mails and system messages, and keep every UI string behind an i18n key so that further locales can be added without code changes.

#### Scenario: Informal address
- **WHEN** a user opens any screen or receives a system mail
- **THEN** the text addresses them as "Du" and never as "Sie"

#### Scenario: No hard-coded strings
- **WHEN** the CI string check runs
- **THEN** it fails on any user-visible string that is not behind an i18n key

### Requirement: Accessibility WCAG 2.2 AA
The system SHALL meet WCAG 2.2 AA in admin UI, portal and public forms: every action is keyboard-operable (including table column picking and bulk selection), focus is visible and not obscured, text contrast is at least 4.5:1, body text is at least 14 px, form errors are announced to screen readers, and pointer targets are at least 24 by 24 px; CI SHALL run automated axe-core checks on every route and fail on any serious violation.

#### Scenario: Keyboard-only column picking
- **WHEN** a user adds, removes and reorders list columns with the keyboard only
- **THEN** every step works without drag-and-drop

#### Scenario: CI accessibility gate
- **WHEN** a route has a serious axe-core violation
- **THEN** the CI pipeline fails

### Requirement: Fixed dashboard
The system SHALL show a start page with fixed tiles, each only if the user has read access to its data: account balances, members (active count, joins and exits this year, 24-month trend), open applications, pending change requests, reconciliation inbox count, open receivables total and overdue count, next planned fee run and collection date, expiring mandates, failed deliveries and admin notes; every tile SHALL link to the filtered list behind it, and the page SHALL load in under 1 second for 2,000 members. No vendor news or feature-request widget is shown.

#### Scenario: Tile hidden without access
- **WHEN** a trainer without finance access opens the dashboard
- **THEN** the account-balance and receivables tiles are not shown

#### Scenario: Tile links to list
- **WHEN** a user clicks the "overdue receivables" tile
- **THEN** the open-items list opens filtered to overdue items

### Requirement: Background job tray
The system SHALL list the user's background jobs in a header tray with kind, start time, progress percentage, state (`queued`, `running`, `done`, `failed`) and result link; progress SHALL update live via server-sent events with polling as fallback; failed jobs SHALL show the error in plain German and offer "retry" where the job is idempotent; admins SHALL see all jobs of the organisation.

#### Scenario: Live progress
- **WHEN** a fee run of 1,200 members runs as a job
- **THEN** the tray shows its progress rising without a page reload

#### Scenario: Failed job
- **WHEN** an export job fails
- **THEN** the tray shows the state `failed`, a German error message and a retry button

### Requirement: Self-ticking first-run checklist
The system SHALL show a first-run checklist whose items tick themselves off from real data: organisation master data and letterhead, SMTP test, chart of accounts, bank accounts and creditor ID, groups and fee plans, members imported or entered, application form published, first fee-run preview, first statement imported, backup target configured. A club-type preset (sport, culture, social, Förderverein) SHALL only preselect groups, fee-plan templates and accounts, without marketing questions.

#### Scenario: Item ticks itself
- **WHEN** the first bank statement is imported
- **THEN** the checklist item "first statement imported" shows as done without user action

### Requirement: Demo mode
The system SHALL provide a demo club (about 150 members, 3 divisions, households, one year of bookings, mandates with test IBANs) loaded by `ovctl seed demo`, refuse to load it into an instance that holds real data, show a permanent banner marking all data as demo data on every page and in every generated document, and support a public demo instance that resets to the seed state on a schedule and on command.

#### Scenario: Demo refused on real data
- **WHEN** an operator runs `ovctl seed demo` on an instance with real members
- **THEN** the command aborts without changing data

#### Scenario: Demo clearly marked
- **WHEN** a visitor opens any page or downloads a PDF on a demo instance
- **THEN** a visible banner or watermark states that the data is fictitious demo data

#### Scenario: Public demo reset
- **WHEN** the scheduled reset runs on the public demo
- **THEN** all visitor changes are discarded and the seed state is restored

### Requirement: Mobile builds via Capacitor
The system SHALL produce Android and iOS builds by wrapping the same web build with Capacitor, with no separate native code path for features; the wrapped app SHALL use the same API, authentication and permission rules as the web app.

#### Scenario: Same build
- **WHEN** a release is built
- **THEN** the mobile packages contain the same web bundle version as the web release

### Requirement: Installable PWA
The system SHALL be installable as a PWA that works on a 390 px wide phone and shows a clear offline state; the MVP SHALL NOT accept offline writes.

#### Scenario: Offline state
- **WHEN** the device loses connectivity
- **THEN** the app shell stays visible with an "offline" notice and write actions are disabled

### Requirement: Business time zone
The system SHALL evaluate every date-driven rule (status changes, mandate expiry, lock-date checks, due dates, retention) in the organisation's business time zone, default `Europe/Berlin`, never in the server's UTC clock.

#### Scenario: Midnight crossing
- **WHEN** a job runs at 23:30 UTC on 31 December, which is already 1 January in Europe/Berlin
- **THEN** it treats today as 1 January and moves a `future` member whose join date is 1 January to `active`

### Requirement: Self-hosted operations
The system SHALL ship `ovctl` with `install` (domain, admin e-mail, SMTP, backup target), `backup` and `restore` (encrypted, off-site), `update` (verifies the image signature, takes a backup first, runs forward-only migrations, and on failure stops the stack and offers restore of the pre-update snapshot, never starting the old image on a migrated schema), `doctor` (disk, certificates, backup age, restore drill, master-key check, SMTP) and `export-all`.

#### Scenario: Failed update
- **WHEN** a migration fails during `ovctl update`
- **THEN** the stack is stopped and the operator is offered `ovctl restore` of the pre-update backup

#### Scenario: Unsigned image refused
- **WHEN** `ovctl update` finds an image whose signature does not verify
- **THEN** the update aborts before any migration runs

### Requirement: No vendor-serving features
The system SHALL NOT include product analytics, session recording, vendor error reporting, third-party captchas, vendor news, feature-request voting, licence or seat limits, or externally loaded fonts and scripts.

#### Scenario: No third-party requests
- **WHEN** a browser loads any OpenVerein page with default settings
- **THEN** no request leaves the club's own origin

### Requirement: Command palette
The system SHALL open a command palette with Ctrl+K (Cmd+K on macOS) from every admin page that lists every navigation target and global action, filters as the user types, and runs the highlighted entry with Enter; modules SHALL be able to add search results (for example members) to it.

#### Scenario: Jump by keyboard
- **WHEN** a signed-in user presses Ctrl+K, types "einst" and presses Enter
- **THEN** the settings page opens without using the mouse

### Requirement: Side sheets and inline editing instead of modal stacks
The system SHALL edit single values in place (click or Enter to edit, Enter to save, Escape to cancel) and open record details in a side sheet over the current list; it SHALL NOT open a modal from within another modal.

#### Scenario: Inline rename
- **WHEN** an admin clicks the club name in the settings, types a new name and presses Enter
- **THEN** the name is saved through the API, the side rail shows the new name and the change is audited

