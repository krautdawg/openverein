## Why

People decide on club software by clicking through it. Slice 9 makes the demo real (a seeded fictitious club, resettable, clearly marked, safe to share publicly) and adds the mobile app projects with Codemagic builds.

## What Changes

- `npm run seed:demo` loads "SV Lindenhof 1921 e.V." (150 members, divisions, youth team, board, fee plans, a posted fee run with payments, mandates with valid test IBANs, calendars and events, folders, an application form) through the public API; `--reset` wipes and reloads a demo instance; real clubs are refused.
- `DEMO_MODE=true`: loads the demo into an empty instance, resets every `DEMO_RESET_HOURS`, shows the credentials on the sign-in page, keeps the banner and PDF watermark, sends no real mail (JSON transport), and locks users, roles, API keys, uploads and mail-server routes.
- Capacitor 8 with Android and iOS projects; the apps open the club's server (`OPENVEREIN_URL`), so they carry the same web build.
- `codemagic.yaml`: unsigned debug workflows (APK, simulator app) and signed release workflows (keystore and App Store Connect from Codemagic); `docs/mobile.md`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `platform`: demo safety rules for public instances.

## Impact

Dependencies `@capacitor/core|android|ios|cli` 8.5.3. New env `DEMO_RESET_HOURS`. Deferred (docs/decisions.md): households and a year of bookings in the demo (bookkeeping is not built yet), `ovctl`.
