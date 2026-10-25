import { z } from 'zod';

export const CONSENT_PURPOSES = ['newsletter', 'photos', 'phone_list', 'other'] as const;
export const CONSENT_PURPOSE_LABEL = { newsletter: 'Newsletter per E-Mail', photos: 'Fotos auf Website und in sozialen Medien', phone_list: 'Kontaktdaten in der Mannschaftsliste', other: 'Sonstiges' } as const;
export const CONSENT_SOURCES = ['form', 'portal', 'paper', 'admin'] as const;
export const CONSENT_SOURCE_LABEL = { form: 'Online-Antrag', portal: 'Mitgliederbereich', paper: 'Auf Papier', admin: 'Mündlich, vom Vorstand erfasst' } as const;

/** Retention shown in the settings; books and vouchers follow § 147 AO (vouchers 8 years since 2025, BEG IV). */
export const RETENTION_CLASSES = [
  { name: 'Bücher, Journal, Jahresabschlüsse', period: '10 Jahre', basis: '§ 147 Abs. 1 Nr. 1, Abs. 3 AO' },
  { name: 'Buchungsbelege, Rechnungen, Zuwendungsbestätigungen', period: '8 Jahre', basis: '§ 147 Abs. 1 Nr. 4, Abs. 3 AO (seit 2025)' },
  { name: 'Sonstige steuerlich bedeutsame Unterlagen, Geschäftsbriefe', period: '6 Jahre', basis: '§ 147 Abs. 1 Nr. 2, 3, 5 AO' },
  { name: 'SEPA-Mandate', period: '14 Monate nach dem letzten Einzug', basis: 'SEPA-Regelwerk: Erstattungsanspruch bei fehlendem Mandat 13 Monate' },
  { name: 'Mitgliedsdaten nach Austritt', period: 'Einstellbar (Standard 24 Monate)', basis: 'Art. 5 Abs. 1 lit. e, Art. 17 DSGVO: nur so lange wie erforderlich' },
] as const;

export const consentInput = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  label: z.string().trim().min(1).max(200).nullable().optional(),
  source: z.enum(CONSENT_SOURCES),
  textVersion: z.string().trim().max(100).nullable().optional(),
});

export const consent = z.object({
  id: z.uuid(),
  purpose: z.enum(CONSENT_PURPOSES),
  label: z.string().nullable(),
  source: z.enum(CONSENT_SOURCES),
  textVersion: z.string().nullable(),
  grantedAt: z.string(),
  withdrawnAt: z.string().nullable(),
  withdrawnSource: z.enum(CONSENT_SOURCES).nullable(),
});
export type Consent = z.infer<typeof consent>;

export const privacyState = z.object({ consents: z.array(consent), legalHoldReason: z.string().nullable(), anonymisedAt: z.string().nullable(), blockers: z.array(z.string()) });
export type PrivacyState = z.infer<typeof privacyState>;

export const reviewItem = z.object({ personId: z.uuid(), name: z.string(), exitDate: z.string(), blockers: z.array(z.string()) });
export type ReviewItem = z.infer<typeof reviewItem>;
