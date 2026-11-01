## Why

Clubs show their people: the KI Klub Werder lists its "KI-Profis" and "KI-Enthusiasten" on its website, and many sports clubs show trainers and board members. KI Klub runs this today in its own app (`klub_profil`). OpenVerein becomes its backend, so the module moves here as a general feature: a member keeps a profile in the portal, the board approves it, and a public feed lets the club website show it.

## What Changes

1. **Data model and portal editing (slice 1).**
   - A profile per membership: display name, bio, place, organisation, an optional photo and an ordered list of links (label, URL).
   - A profile type from a list the club defines. `none` is the default and means "not public". The KI Klub types are Enthusiast and Profi.
   - Contact visibility: board (the default), members or public.
   - Members edit all of it in the portal and can hide the profile at any time, which takes effect at once.
   - The photo is stored as a member file. It is public only while the member has the `photos` consent.
   - The demo seed gets a few profiles.
2. **Board approval and public feed (slice 2).**
   - An approval queue for the board. A profile is public only if its type is not `none`, the board approved this version, and it is not hidden.
   - Any change to public content takes the profile back to the queue (approval per version, as KI Klub decided on 2026-09-09).
   - A read-only feed per club host, `GET /api/v1/public/profiles`, plus the photo route:
     - approved profiles only
     - the contact e-mail only when its visibility is public
     - a photo URL with a content hash
     - CORS for club websites, short cache headers and a rate limit
   - Admin settings for the profile types.
3. **Import from KI Klub (slice 3).**
   - A dry-run-first importer for `klub_profil`, `klub_profil_link` and the bytea photos, matched to OpenVerein members by e-mail, with a fixture test.
   - It never runs against KI Klub production; Tim migrates.

## Capabilities

### Modified Capabilities

- `member-portal`: profile editing.
- `members`: approval.
- `api`: the public feed.

## Impact

- Migrations: profile tables, profile types on the organization, and the file purpose `photo`.
- The full export, erasure, tenant purge and Art. 15 cover the new tables.
- Out of scope: changing ki-klub-werder.de/ki-profis, which happens at migration time in the KI Klub repo.
