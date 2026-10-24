import { z } from 'zod';
import { isValidBic, isValidIban, normalizeIban } from './iban.ts';

const iban = z.string().trim().max(42).transform(normalizeIban).refine(isValidIban, 'Diese IBAN ist nicht gültig (Prüfziffer).');
const bic = z.string().trim().max(11).nullish().transform((v) => (v ? v.replace(/\s+/g, '').toUpperCase() : null)).refine((v) => !v || isValidBic(v), 'Diese BIC ist nicht gültig.');

export const MANDATE_STATUS_LABEL = { pending_evidence: 'Unterschrift fehlt', active: 'Aktiv', revoked: 'Widerrufen', expired: 'Abgelaufen' } as const;

export const mandateCreate = z.object({
  reference: z.string().trim().regex(/^[A-Za-z0-9/?:().,'+ -]{1,35}$/, 'Höchstens 35 Zeichen: Buchstaben, Ziffern und / - ? : ( ) . , \' +').optional(),
  signedOn: z.iso.date('Bitte das Datum der Unterschrift angeben.'),
  accountHolder: z.string().trim().min(2, 'Pflichtfeld.').max(70),
  iban,
  bic,
  type: z.enum(['recurrent', 'one_off']).default('recurrent'),
  pendingEvidence: z.boolean().default(false),
});

export const mandate = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  reference: z.string(),
  signedOn: z.string(),
  accountHolder: z.string(),
  ibanMasked: z.string(),
  /** only for users who may see IBANs */
  iban: z.string().optional(),
  bic: z.string().nullable(),
  type: z.enum(['recurrent', 'one_off']),
  status: z.enum(['pending_evidence', 'active', 'revoked', 'expired']),
  lastCollectedOn: z.string().nullable(),
  revokedOn: z.string().nullable(),
  revokeReason: z.string().nullable(),
});
export type Mandate = z.infer<typeof mandate>;

export const bankAccountInput = z.object({
  name: z.string().trim().min(1).max(80),
  iban,
  bic,
  openingBalanceCents: z.number().int().default(0),
  openingDate: z.iso.date(),
  minLeadDays: z.number().int().min(1).max(15).default(2),
  orderLimitCents: z.number().int().positive().nullish(),
});
export const bankAccount = z.object({
  id: z.uuid(),
  name: z.string(),
  iban: z.string(),
  bic: z.string().nullable(),
  openingBalanceCents: z.number(),
  openingDate: z.string(),
  minLeadDays: z.number(),
  orderLimitCents: z.number().nullable(),
  balanceCents: z.number(),
  lastBookingDate: z.string().nullable(),
  unmatched: z.number(),
});
export type BankAccount = z.infer<typeof bankAccount>;

export const READINESS_LABEL = { ok: 'Bereit', no_mandate: 'Kein aktives Mandat', in_run: 'Bereits in einem Einzug', not_debit: 'Zahlt nicht per Lastschrift', no_iban: 'Keine Bankverbindung', no_prenotification: 'Keine Vorabankündigung mit diesem Mandat' } as const;
export const candidate = z.object({
  invoiceId: z.uuid(),
  number: z.string(),
  recipientName: z.string(),
  memberId: z.uuid().nullable(),
  dueDate: z.string().nullable(),
  openCents: z.number(),
  kind: z.string(),
  mandateReference: z.string().nullable(),
  readiness: z.enum(['ok', 'no_mandate', 'in_run', 'not_debit', 'no_iban', 'no_prenotification']),
});
export type Candidate = z.infer<typeof candidate>;

export const runCreate = z.object({
  kind: z.enum(['debit', 'transfer']).default('debit'),
  bankAccountId: z.uuid(),
  collectionDate: z.iso.date(),
  invoiceIds: z.array(z.uuid()).min(1, 'Wähle mindestens eine Rechnung.').max(10_000),
});

export const RUN_STATUS_LABEL = { draft: 'Entwurf', generated: 'Datei erzeugt', downloaded: 'Heruntergeladen', submitted: 'Bei der Bank eingereicht', settled: 'Gutgeschrieben', released: 'Freigegeben (nicht eingereicht)' } as const;
export const run = z.object({
  id: z.uuid(),
  kind: z.enum(['debit', 'transfer']),
  bankAccountId: z.uuid(),
  bankAccountName: z.string(),
  collectionDate: z.string(),
  status: z.enum(['draft', 'generated', 'downloaded', 'submitted', 'settled', 'released']),
  createdAt: z.string(),
  itemCount: z.number(),
  totalCents: z.number(),
  files: z.array(z.object({ position: z.number(), messageId: z.string(), sequenceType: z.string().nullable(), itemCount: z.number(), controlSumCents: z.number(), sha256: z.string(), downloadedAt: z.string().nullable() })),
  items: z.array(z.object({ id: z.uuid(), endToEndId: z.string(), name: z.string(), amountCents: z.number(), status: z.enum(['included', 'settled', 'returned', 'withdrawn']), invoiceNumbers: z.array(z.string()), mandateReference: z.string().nullable() })),
});
export type Run = z.infer<typeof run>;
export const runSummary = run.omit({ items: true, files: true });

export const importInput = z.object({
  format: z.enum(['camt053', 'csv']),
  fileName: z.string().max(200).optional(),
  content: z.string().min(1).max(50 * 1024 * 1024),
  /** import although the closing balance does not match, with the reason */
  balanceOverrideReason: z.string().trim().min(3).max(300).optional(),
});
export const importResult = z.object({
  id: z.uuid(),
  imported: z.number(),
  duplicates: z.number(),
  autoMatched: z.number(),
  returns: z.number(),
  warnings: z.array(z.string()),
});

export const suggestion = z.object({ invoiceId: z.uuid(), number: z.string(), recipientName: z.string(), openCents: z.number(), score: z.number(), rule: z.string() });
export const bankTx = z.object({
  id: z.uuid(),
  bankAccountId: z.uuid(),
  bookingDate: z.string(),
  amountCents: z.number(),
  counterpartyName: z.string().nullable(),
  counterpartyIbanMasked: z.string().nullable(),
  remittance: z.string(),
  endToEndId: z.string().nullable(),
  returnReason: z.string().nullable(),
  status: z.enum(['unmatched', 'matched', 'ignored']),
  note: z.string().nullable(),
  allocations: z.array(z.object({ invoiceId: z.uuid(), number: z.string().nullable(), amountCents: z.number() })),
  suggestions: z.array(suggestion),
});
export type BankTx = z.infer<typeof bankTx>;
export const allocateInput = z.object({ allocations: z.array(z.object({ invoiceId: z.uuid(), amountCents: z.number().int().positive() })).min(1).max(100) });
