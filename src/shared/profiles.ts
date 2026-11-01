import { z } from 'zod';

/** Public member profiles (change public-profiles), shared by the portal, the admin app and the server. */
export const CONTACT_VISIBILITY_LABEL = { board: 'Nur der Vorstand', members: 'Die Mitglieder', public: 'Öffentlich' } as const;
export const PROFILE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PROFILE_PHOTO_MAX = 2 * 1024 * 1024;

const optionalText = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable();

export const profileLink = z.object({
  label: z.string().trim().min(1, 'Bitte benennen.').max(60),
  url: z.string().trim().max(500).regex(/^https?:\/\/[^\s]+$/i, 'Bitte eine Adresse mit https:// angeben.'),
});

export const profileInput = z.object({
  displayName: optionalText(80),
  bio: optionalText(2000),
  place: optionalText(80),
  organisation: optionalText(120),
  links: z.array(profileLink).max(10).default([]),
  typeKey: z.string().regex(/^[a-z0-9_-]{1,40}$/).default('none'),
  contactVisibility: z.enum(['board', 'members', 'public']).default('board'),
  hidden: z.boolean().default(false),
});

export const profileType = z.object({ key: z.string(), label: z.string() });

export const profileDto = z.object({
  memberId: z.uuid(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  place: z.string().nullable(),
  organisation: z.string().nullable(),
  links: z.array(profileLink),
  typeKey: z.string(),
  contactVisibility: z.enum(['board', 'members', 'public']),
  hidden: z.boolean(),
  photo: z.object({ size: z.number(), type: z.string() }).nullable(),
  /** approved = the board approved this version; public = it is in the feed now */
  approved: z.boolean(),
  public: z.boolean(),
  /** photo shown publicly only with this consent */
  photoConsent: z.boolean(),
  types: z.array(profileType),
});
export type ProfileDto = z.infer<typeof profileDto>;
