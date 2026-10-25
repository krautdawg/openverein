import { z } from 'zod';

export const cents = z.number().int().min(0).max(100_000_000);
const isoDate = z.iso.date('Bitte ein Datum im Format JJJJ-MM-TT angeben.');

export const PAYMENT_METHODS = ['none', 'direct_debit', 'transfer', 'cash'] as const;
export const PAYMENT_METHOD_LABEL: Record<(typeof PAYMENT_METHODS)[number], string> = { none: 'Nicht festgelegt', direct_debit: 'Lastschrift', transfer: 'Überweisung', cash: 'Bar' };

export const INTERVAL_LABEL = (n: number | null) =>
  n === null ? 'einmalig' : ({ 1: 'monatlich', 3: 'vierteljährlich', 6: 'halbjährlich', 12: 'jährlich' } as Record<number, string>)[n] ?? `alle ${n} Monate`;

export const versionInput = z.object({
  validFrom: isoDate,
  amountCents: cents,
  intervalMonths: z.number().int().min(1, 'Zwischen 1 und 60 Monaten.').max(60, 'Zwischen 1 und 60 Monaten.').nullable(),
  anchor: z.enum(['calendar', 'entry']).default('calendar'),
  proration: z.enum(['none', 'month']).default('month'),
  admissionFeeCents: cents.default(0),
});

export const planCreate = z.object({
  name: z.string().trim().min(1, 'Pflichtfeld.').max(120),
  lineText: z.string().trim().min(1).max(200).default('{plan} {period_start}–{period_end}'),
  version: versionInput,
});
export const planPatch = z.object({ name: z.string().trim().min(1).max(120).optional(), lineText: z.string().trim().min(1).max(200).optional() });

export const planVersion = versionInput.extend({ id: z.uuid() });
export const plan = z.object({
  id: z.uuid(),
  name: z.string(),
  lineText: z.string(),
  status: z.enum(['active', 'retired']),
  versions: z.array(planVersion),
  current: planVersion.nullable(),
  assignedMembers: z.number(),
});
export type Plan = z.infer<typeof plan>;

export const assignmentInput = z.object({
  feePlanId: z.uuid(),
  isMain: z.boolean().default(true),
  validFrom: isoDate,
  validTo: isoDate.nullish(),
  firstPeriodStart: isoDate.nullish(),
  overrideCents: cents.nullish(),
  overrideReason: z.string().trim().max(200).nullish(),
});
export const assignment = z.object({
  id: z.uuid(),
  feePlanId: z.uuid(),
  planName: z.string(),
  isMain: z.boolean(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  firstPeriodStart: z.string().nullable(),
  overrideCents: z.number().nullable(),
  overrideReason: z.string().nullable(),
});
export type Assignment = z.infer<typeof assignment>;

export const feeLine = z.object({
  key: z.string(),
  assignmentId: z.uuid(),
  slot: z.string(),
  kind: z.enum(['fee', 'admission']),
  periodStart: z.string(),
  periodEnd: z.string(),
  amountCents: z.number(),
  fullCents: z.number(),
  catchUp: z.boolean(),
  text: z.string(),
  explanation: z.string(),
});
export type FeeLine = z.infer<typeof feeLine>;
export const skippedLine = z.object({ slot: z.string(), periodStart: z.string(), periodEnd: z.string(), reason: z.string() });

export const memberFees = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
  assignments: z.array(assignment),
});

export const calculatorResult = z.object({ lines: z.array(feeLine), skipped: z.array(skippedLine), totalCents: z.number() });

export const previewMember = z.object({
  memberId: z.uuid(),
  name: z.string(),
  membershipNumber: z.string(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  lines: z.array(feeLine),
  skipped: z.array(skippedLine),
  warnings: z.array(z.string()),
  totalCents: z.number(),
  hash: z.string(),
});
export type PreviewMember = z.infer<typeof previewMember>;

export const previewHousehold = z.object({
  householdId: z.uuid(),
  name: z.string(),
  payerName: z.string(),
  memberIds: z.array(z.uuid()),
  discountCents: z.number(),
  label: z.string(),
});
export type PreviewHouseholdDto = z.infer<typeof previewHousehold>;

export const feeRunCreate = z.object({
  until: isoDate,
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  groupId: z.uuid().nullish(),
});
export const feeRun = z.object({
  id: z.uuid(),
  until: z.string(),
  issueDate: z.string(),
  dueDate: z.string(),
  groupId: z.uuid().nullable(),
  status: z.enum(['preview', 'posted', 'cancelled']),
  createdAt: z.string(),
  postedAt: z.string().nullable(),
  members: z.array(previewMember),
  /** households billed on one invoice to the payer, with their family discount */
  households: z.array(previewHousehold),
  totals: z.object({ members: z.number(), lines: z.number(), totalCents: z.number(), catchUpLines: z.number(), warnings: z.number() }),
  invoiceCount: z.number(),
});
export type FeeRun = z.infer<typeof feeRun>;
export const feeRunSummary = feeRun.omit({ members: true, households: true });
export const feeRunPost = z.object({ excludeLineKeys: z.array(z.string()).max(100_000).default([]) });

export const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
