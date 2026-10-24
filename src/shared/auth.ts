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

export const me = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  organization: z.object({ id: z.uuid(), name: z.string(), isDemo: z.boolean() }),
});
export type Me = z.infer<typeof me>;
