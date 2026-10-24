import { isValidBic, isValidIban, normalizeIban } from './iban.ts';
import { z } from 'zod';

export const organization = z.object({
  id: z.uuid(),
  name: z.string(),
  timeZone: z.string(),
  isDemo: z.boolean(),
  memberNumberPattern: z.string(),
  noticeWeeks: z.number(),
  exitAt: z.enum(['any_day', 'month_end', 'quarter_end', 'half_year_end', 'year_end']),
  street: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  email: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  bankName: z.string().nullable(),
  invoiceNumberPattern: z.string(),
  cancellationNumberPattern: z.string(),
  paymentTermsDays: z.number(),
  dunningLevels: z.array(z.object({ level: z.number(), label: z.string(), days: z.number(), feeCents: z.number() })),
});
export type Organization = z.infer<typeof organization>;

const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const numberPattern = z.string().trim().min(1).max(40).refine((p) => /\{seq(:\d)?\}/.test(p) && !/\{(?!seq(:\d)?\}|YYYY\})/.test(p), 'Das Muster braucht {seq} oder {seq:4}; erlaubt ist außerdem {YYYY}.');

export const organizationPatch = z.object({
  name: z.string().trim().min(2, 'Mindestens 2 Zeichen.').max(200).optional(),
  memberNumberPattern: numberPattern.optional(),
  noticeWeeks: z.number().int().min(0).max(104).optional(),
  exitAt: z.enum(['any_day', 'month_end', 'quarter_end', 'half_year_end', 'year_end']).optional(),
  street: optText(200),
  postalCode: optText(20),
  city: optText(100),
  email: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254).nullish().or(z.literal('').transform(() => null)),
  iban: z.string().trim().max(40).nullish().transform((v) => (v ? normalizeIban(v) : v === '' ? null : v)).refine((v) => !v || isValidIban(v), 'Diese IBAN ist nicht gültig (Prüfziffer).'),
  bic: z.string().trim().max(11).nullish().transform((v) => (v ? v.replace(/\s+/g, '').toUpperCase() : v === '' ? null : v)).refine((v) => !v || isValidBic(v), 'Diese BIC ist nicht gültig.'),
  bankName: optText(100),
  invoiceNumberPattern: numberPattern.optional(),
  cancellationNumberPattern: numberPattern.optional(),
  paymentTermsDays: z.number().int().min(0).max(120).optional(),
  dunningLevels: z.array(z.object({ level: z.number().int().min(1).max(9), label: z.string().trim().min(1).max(60), days: z.number().int().min(1).max(365), feeCents: z.number().int().min(0).max(10_000) })).max(5).optional(),
});
