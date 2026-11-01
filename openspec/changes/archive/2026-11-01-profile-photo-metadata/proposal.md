## Why

Public profile photos were served with their camera metadata. A phone JPEG with EXIF GPS publishes where the member lives.

## What Changes

- Profile photos are stored without metadata. On upload and on the KI Klub import, only what draws the picture is kept, plus the EXIF orientation.
- The public photo route cleans again on the way out, under its own ETag. This covers photos stored before the change.
- A file whose structure doesn't parse, and animated WebP, are refused.

## Impact

- `src/server/profiles/service.ts` (`stripPhotoMetadata`), the portal upload, the KI Klub import and the public photo route.
- No new dependency and no migration.
