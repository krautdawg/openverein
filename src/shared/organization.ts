import { z } from 'zod';

export const organization = z.object({
  id: z.uuid(),
  name: z.string(),
  timeZone: z.string(),
  isDemo: z.boolean(),
});
export type Organization = z.infer<typeof organization>;

export const organizationPatch = z.object({
  name: z.string().trim().min(2, 'Mindestens 2 Zeichen.').max(200).optional(),
});
