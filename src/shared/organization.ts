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
  remittanceTemplate: z.string(),
  invoiceCoverTemplate: z.string().nullable(),
  invoiceClosingTemplate: z.string().nullable(),
  portalFeatures: z.record(z.string(), z.boolean()),
  mailFromName: z.string().nullable(),
  mailFromAddress: z.string().nullable(),
  mailReplyTo: z.string().nullable(),
  mailPerMinute: z.number(),
  mailPausedReason: z.string().nullable(),
  electronicMandatesAgreed: z.boolean(),
  joinRule: z.enum(['application_date', 'acceptance_date', 'month_first', 'next_month_first']),
  vatId: z.string().nullable(),
  taxNumber: z.string().nullable(),
  registerNumber: z.string().nullable(),
  smallBusiness: z.boolean(),
  einvoiceContactName: z.string().nullable(),
  einvoiceContactPhone: z.string().nullable(),
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
  portalFeatures: z.record(z.string(), z.boolean()).refine((v) => Object.keys(v).every((k) => k in PORTAL_FEATURES), 'Unbekannte Portalfunktion.').optional(),
  invoiceCoverTemplate: z.string().trim().max(2000).nullish().transform((v) => v || null).optional(),
  invoiceClosingTemplate: z.string().trim().max(2000).nullish().transform((v) => v || null).optional(),
  remittanceTemplate: z.string().trim().min(1).max(140).refine((t) => [...t.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].every((m) => m[1]! in REMITTANCE_PLACEHOLDERS), 'Unbekannter Platzhalter. Erlaubt: {{rechnungsnummer}}, {{mitgliedsnummer}}, {{zeitraum}}, {{verein}}.').optional(),
  mailFromName: optText(100),
  mailFromAddress: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254).nullish().or(z.literal('').transform(() => null)).optional(),
  mailPerMinute: z.number().int().min(1).max(1000).optional(),
  electronicMandatesAgreed: z.boolean().optional(),
  joinRule: z.enum(['application_date', 'acceptance_date', 'month_first', 'next_month_first']).optional(),
  vatId: z.preprocess((v) => (typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v), z.string().regex(/^[A-Z]{2}[A-Z0-9]{2,13}$/, 'Format: Länderkürzel und Nummer, z. B. DE123456789.').nullish().or(z.literal('').transform(() => null))).optional(),
  taxNumber: optText(30),
  registerNumber: optText(100),
  smallBusiness: z.boolean().optional(),
  einvoiceContactName: optText(100),
  einvoiceContactPhone: optText(40),
  mailReplyTo: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254).nullish().or(z.literal('').transform(() => null)).optional(),
  creditorId: z.preprocess((v) => (typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v), z.string().max(35).nullish().transform((v) => (v === '' ? null : v)).refine((v) => !v || isValidCreditorId(v), 'Diese Gläubiger-ID ist nicht gültig (Prüfziffer).')).optional(),
  dunningLevels: z
    .array(z.object({ level: z.number().int().min(1).max(9), label: z.string().trim().min(1).max(60), days: z.number().int().min(1).max(365), feeCents: z.number().int().min(0).max(10_000) }))
    .max(5)
    .refine((ls) => ls.every((l, i) => i === 0 || (l.level > ls[i - 1]!.level && l.days > ls[i - 1]!.days)), 'Stufen aufsteigend nummerieren, jede Stufe mit mehr Tagen als die vorige.')
    .optional(),
});

/** Placeholders of the SEPA remittance text (Verwendungszweck); the bank shows at most 140 characters. */
export const REMITTANCE_PLACEHOLDERS = { rechnungsnummer: 'Rechnungsnummer', mitgliedsnummer: 'Mitgliedsnummer', zeitraum: 'Beitragszeitraum, z. B. 01.01.2026–31.12.2026', verein: 'Name des Vereins' } as const;

export function fillRemittance(template: string, values: Partial<Record<keyof typeof REMITTANCE_PLACEHOLDERS, string>>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => values[k as keyof typeof REMITTANCE_PLACEHOLDERS] ?? '').replace(/\s+/g, ' ').trim();
}

/** Member portal functions the club can switch off; each group can allow or deny one for its members. */
export const PORTAL_FEATURES = {
  profile: 'Eigene Daten ändern',
  bank: 'Bankverbindung ändern',
  invoices: 'Rechnungen ansehen',
  mandate: 'Lastschriftmandat anzeigen',
  resignation: 'Kündigen',
  contact: 'Kontakt zum Verein anzeigen',
} as const;
export type PortalFeature = keyof typeof PORTAL_FEATURES;
export const PORTAL_FEATURE_KEYS = Object.keys(PORTAL_FEATURES) as [PortalFeature, ...PortalFeature[]];
export const portalFeatures = z.object(Object.fromEntries(PORTAL_FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<PortalFeature, z.ZodBoolean>);
export const portalOverrides = z.partialRecord(z.enum(PORTAL_FEATURE_KEYS), z.enum(['allow', 'deny']));

/** A member gets a function if one of their current groups allows it and none denies it; otherwise the club setting applies. */
export function resolvePortalFeatures(club: Partial<Record<string, boolean>>, groups: Partial<Record<string, string>>[]): Record<PortalFeature, boolean> {
  return Object.fromEntries(PORTAL_FEATURE_KEYS.map((k) => [k, groups.some((g) => g[k] === 'deny') ? false : groups.some((g) => g[k] === 'allow') || (club[k] ?? true)])) as Record<PortalFeature, boolean>;
}
