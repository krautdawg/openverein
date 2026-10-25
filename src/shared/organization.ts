import { isValidBic, isValidCreditorId, isValidIban, normalizeIban } from './iban.ts';
import { z } from 'zod';

export const organization = z.object({
  id: z.uuid(),
  /** send back as If-Match when changing (412 when someone changed it meanwhile) */
  version: z.string(),
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
  creditorId: z.string().nullable(),
  prenotificationDays: z.number(),
  mailFromName: z.string().nullable(),
  mailFromAddress: z.string().nullable(),
  mailReplyTo: z.string().nullable(),
  mailPerMinute: z.number(),
  mailPausedReason: z.string().nullable(),
  electronicMandatesAgreed: z.boolean(),
  joinRule: z.enum(['application_date', 'acceptance_date', 'month_first', 'next_month_first']),
});
export type Organization = z.infer<typeof organization>;

// Absent keys must stay absent (undefined): a PATCH of one field may not clear the others.
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v || null));
const numberPattern = z.string().trim().min(1).max(40).refine((p) => /\{seq(:\d)?\}/.test(p) && !/\{(?!seq(:\d)?\}|YYYY\})/.test(p), 'Das Muster braucht {seq} oder {seq:4}; erlaubt ist außerdem {YYYY}.');

export const organizationPatch = z.object({
  name: z.string().trim().min(2, 'Mindestens 2 Zeichen.').max(200).optional(),
  memberNumberPattern: numberPattern.optional(),
  noticeWeeks: z.number().int().min(0).max(104).optional(),
  exitAt: z.enum(['any_day', 'month_end', 'quarter_end', 'half_year_end', 'year_end']).optional(),
  street: optText(200),
  postalCode: optText(20),
  city: optText(100),
  email: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254).nullish().or(z.literal('').transform(() => null)).optional(),
  iban: z.string().trim().max(42).nullish().transform((v) => (v ? normalizeIban(v) : v === '' ? null : v)).refine((v) => !v || isValidIban(v), 'Diese IBAN ist nicht gültig (Prüfziffer).').optional(),
  bic: z.preprocess((v) => (typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v), z.string().max(11).nullish().transform((v) => (v === '' ? null : v)).refine((v) => !v || isValidBic(v), 'Diese BIC ist nicht gültig.')).optional(),
  bankName: optText(100),
  invoiceNumberPattern: numberPattern.optional(),
  cancellationNumberPattern: numberPattern.optional(),
  paymentTermsDays: z.number().int().min(0).max(120).optional(),
  prenotificationDays: z.number().int().min(1).max(60).optional(),
  mailFromName: optText(100),
  mailFromAddress: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254).nullish().or(z.literal('').transform(() => null)).optional(),
  mailPerMinute: z.number().int().min(1).max(1000).optional(),
  electronicMandatesAgreed: z.boolean().optional(),
  joinRule: z.enum(['application_date', 'acceptance_date', 'month_first', 'next_month_first']).optional(),
  mailReplyTo: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254).nullish().or(z.literal('').transform(() => null)).optional(),
  creditorId: z.preprocess((v) => (typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v), z.string().max(35).nullish().transform((v) => (v === '' ? null : v)).refine((v) => !v || isValidCreditorId(v), 'Diese Gläubiger-ID ist nicht gültig (Prüfziffer).')).optional(),
  dunningLevels: z
    .array(z.object({ level: z.number().int().min(1).max(9), label: z.string().trim().min(1).max(60), days: z.number().int().min(1).max(365), feeCents: z.number().int().min(0).max(10_000) }))
    .max(5)
    .refine((ls) => ls.every((l, i) => i === 0 || (l.level > ls[i - 1]!.level && l.days > ls[i - 1]!.days)), 'Stufen aufsteigend nummerieren, jede Stufe mit mehr Tagen als die vorige.')
    .optional(),
});
