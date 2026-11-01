## Decisions

1. **One profile per membership** (`member_profile.member_id` unique). The portal edits the profiles of the memberships under the signed-in address. A household payer also edits the profile of a child they manage, as with the other portal data.
2. **Types are club data**: `organization.profile_types` is a JSON list of `{ key, label }`. `none` is implicit and not stored. Removing a type moves its profiles to `none`, so they are no longer public.
3. **Public = type ≠ none AND approved AND not hidden AND the membership is current.** Approval belongs to one version: every change to name, bio, place, organisation, links, photo or type clears it, so a profile goes back to the queue. Hiding is the member's switch and needs no approval. Contact visibility does not need approval either, because it only narrows or widens one field the member owns.
4. **Photo**: a `file` row with purpose `photo`, owned by the member: JPEG, PNG or WebP up to 2 MB, magic bytes checked. It is served publicly only while the person has an active `photos` consent and the profile is public, with `X-Content-Type-Options: nosniff`, a content-hash cache buster and `Cache-Control: public, max-age=300` (revocation takes effect within minutes). There is no image re-encoding; members upload their own picture.
5. **Contact**: the portal e-mail of the person. Board visibility means only admins with member rights see it; members visibility means signed-in members of the club (a later directory); public visibility puts it in the feed.
6. **Feed per club host**: `GET /api/v1/public/profiles` resolves the club by host (managed hosting) or takes the single club.
   - The answer carries `{ profiles: [{ id, type, typeLabel, name, bio, place, organisation, links, photoUrl, email? }] }`, `Access-Control-Allow-Origin: *` without credentials, `Cache-Control: public, max-age=300`, an ETag and a per-IP limit.
   - The operation IDs make it an agent tool like everything else.
7. **Privacy**:
   - The Art. 15 export includes the profile and its links, and the photo as a member file.
   - Erasure deletes the profile; the photo goes with the member files.
   - The full export includes both tables; the links are a child table.
