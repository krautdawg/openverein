import { z } from 'zod';

export const email = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.email('Bitte gib eine gültige E-Mail-Adresse an.').max(254),
);

export const loginBody = z.object({ email, password: z.string().min(1).max(128) });

export const setupBody = z.object({
  clubName: z.string().trim().min(2, 'Mindestens 2 Zeichen.').max(200),
  name: z.string().trim().min(2, 'Mindestens 2 Zeichen.').max(120),
  email,
  password: z.string().min(12, 'Mindestens 12 Zeichen.').max(128, 'Höchstens 128 Zeichen.'),
});

export const levelSchema = z.enum(['none', 'read', 'write']);

export const me = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  organization: z.object({ id: z.uuid(), name: z.string(), isDemo: z.boolean() }),
  /** Effective level per module, so the UI can hide what the user may not use. The API enforces it regardless. */
  permissions: z.record(z.string(), levelSchema),
  roles: z.array(z.string()),
  /** Member fields the user's roles hide (birth_date, email, iban …); the UI leaves them out, the API enforces it. */
  restricted: z.array(z.string()).default([]),
  /** Second factor: required for finance roles; enrolled once set up. */
  mfa: z.object({ required: z.boolean(), enrolled: z.boolean() }),
});

/** Answer of a password login when the account uses TOTP: no session yet, only a short-lived ticket. */
export const loginTicket = z.object({ totpRequired: z.literal(true), ticket: z.string() });
/** A six-digit code, or a recovery code in any case, with or without dashes (normalised to "abcd-efgh-jkmn"). */
export const totpCode = z
  .string()
  .trim()
  .transform((v) => (/^\d{6}$/.test(v) ? v : v.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3')))
  .pipe(z.string().regex(/^(\d{6}|[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4})$/, 'Sechs Ziffern aus der App oder ein Wiederherstellungscode.'));

export const acceptInviteBody = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12, 'Mindestens 12 Zeichen.').max(128, 'Höchstens 128 Zeichen.'),
});
export type Me = z.infer<typeof me>;
