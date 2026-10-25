import { z } from 'zod';
import { isValidIban, normalizeIban } from './iban.ts';

const text = (max: number) => z.string().trim().max(max);
const required = (max: number, message = 'Bitte ausfüllen.') => z.string().trim().min(1, message).max(max);

/** What an applicant sends. Guardian data is required for applicants under 18 (checked on the server). */
export const applicationData = z.object({
  firstName: required(100),
  lastName: required(100),
  birthDate: z.iso.date('Bitte das Geburtsdatum angeben.'),
  email: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254),
  phone: text(50).optional(),
  street: required(200),
  postalCode: z.string().trim().regex(/^\d{5}$/, 'Die Postleitzahl hat fünf Ziffern.'),
  city: required(100),
  groupIds: z.array(z.uuid()).max(20).default([]),
  feePlanId: z.uuid().nullish(),
  guardian: z.object({ name: required(150), email: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254), phone: text(50).optional() }).nullish(),
  mandate: z
    .object({
      accountHolder: required(70),
      iban: z.string().transform(normalizeIban).refine(isValidIban, 'Diese IBAN ist nicht gültig.'),
    })
    .nullish(),
  note: text(2000).optional(),
});
export type ApplicationData = z.infer<typeof applicationData>;
/** The same data as stored (no input transforms), for responses. */
export const applicationDataOut = applicationData.extend({ mandate: z.object({ accountHolder: z.string(), iban: z.string() }).nullish() });

export const submission = z.object({
  token: z.string().max(200),
  /** honeypot: people never see or fill it */
  website: z.string().max(200).optional(),
  consent: z.literal(true, 'Bitte stimme zu, um den Antrag abzuschicken.'),
  data: applicationData,
});

export const publicForm = z.object({
  title: z.string(),
  intro: z.string().nullable(),
  clubName: z.string(),
  groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
  feePlans: z.array(z.object({ id: z.uuid(), name: z.string(), amountCents: z.number(), interval: z.string() })),
  askMandate: z.boolean(),
  creditorId: z.string().nullable(),
  consentText: z.string(),
  privacyUrl: z.string().nullable(),
  token: z.string(),
});

export const formInput = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,60}$/, '3 bis 60 Zeichen: Kleinbuchstaben, Ziffern, Bindestriche.'),
  title: required(120),
  intro: text(4000).nullish(),
  groupIds: z.array(z.uuid()).max(50).default([]),
  feePlanIds: z.array(z.uuid()).max(20).default([]),
  askMandate: z.boolean().default(true),
  consentText: required(4000, 'Bitte einen Einwilligungstext angeben.'),
  privacyUrl: z.url('Bitte eine vollständige Adresse angeben (https://…).').max(500).nullish().or(z.literal('').transform(() => null)),
  allowedOrigins: z.array(z.url({ protocol: /^https?$/, error: 'Bitte eine Adresse mit https:// angeben.' }).transform((u) => new URL(u).origin)).max(10).default([]),
  active: z.boolean().default(true),
});

export const MANDATE_TEXT = (club: string, creditorId: string | null) =>
  `Ich ermächtige ${club}${creditorId ? ` (Gläubiger-ID ${creditorId})` : ''}, Zahlungen von meinem Konto mittels Lastschrift einzuziehen. Zugleich weise ich mein Kreditinstitut an, die von ${club} auf mein Konto gezogenen Lastschriften einzulösen. Hinweis: Ich kann innerhalb von acht Wochen, beginnend mit dem Belastungsdatum, die Erstattung des belasteten Betrages verlangen. Es gelten dabei die mit meinem Kreditinstitut vereinbarten Bedingungen.`;

/** Age in whole years on a given day. */
export function ageOn(birthDate: string, day: string) {
  const years = Number(day.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return day.slice(5) < birthDate.slice(5) ? years - 1 : years;
}
