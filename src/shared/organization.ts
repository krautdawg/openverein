import { z } from 'zod';

export const organization = z.object({
  id: z.uuid(),
  name: z.string(),
  timeZone: z.string(),
  isDemo: z.boolean(),
  memberNumberPattern: z.string(),
  noticeWeeks: z.number(),
  exitAt: z.enum(['any_day', 'month_end', 'quarter_end', 'half_year_end', 'year_end']),
});
export type Organization = z.infer<typeof organization>;

export const organizationPatch = z.object({
  name: z.string().trim().min(2, 'Mindestens 2 Zeichen.').max(200).optional(),
  memberNumberPattern: z.string().trim().min(1).max(40).refine((p) => p.includes('{seq'), 'Das Muster braucht {seq} oder {seq:4}.').optional(),
  noticeWeeks: z.number().int().min(0).max(104).optional(),
  exitAt: z.enum(['any_day', 'month_end', 'quarter_end', 'half_year_end', 'year_end']).optional(),
});
