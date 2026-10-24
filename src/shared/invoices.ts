import { z } from 'zod';
import { cents } from './fees.ts';

export const INVOICE_STATUS_LABEL = {
  draft: 'Entwurf',
  issued: 'Ausgestellt',
  open: 'Offen',
  partially_paid: 'Teilweise bezahlt',
  paid: 'Bezahlt',
  cancelled: 'Storniert',
  written_off: 'Ausgebucht',
} as const;
export const INVOICE_KIND_LABEL = {
  membership: 'Beitragsrechnung',
  other: 'Rechnung',
  credit_note: 'Gutschrift',
  cancellation: 'Stornorechnung',
  dunning_fee: 'Mahngebühr',
} as const;

export const lineInput = z.object({
  text: z.string().trim().min(1, 'Pflichtfeld.').max(500),
  quantity: z.number().positive().max(100_000).default(1),
  unitCents: cents,
  taxRate: z.union([z.literal(0), z.literal(7), z.literal(19)]).default(0),
});

export const invoiceCreate = z.object({
  memberId: z.uuid(),
  kind: z.enum(['other', 'credit_note']).default('other'),
  dueDate: z.iso.date().nullish(),
  coverText: z.string().trim().max(2000).nullish(),
  lines: z.array(lineInput).min(1, 'Mindestens eine Position.').max(200),
});
export const invoicePatch = invoiceCreate.omit({ memberId: true }).partial();

export const invoiceLine = z.object({ id: z.uuid(), position: z.number(), text: z.string(), quantity: z.number(), unitCents: z.number(), totalCents: z.number(), taxRate: z.number(), periodStart: z.string().nullable(), periodEnd: z.string().nullable() });
export const allocationDto = z.object({ id: z.uuid(), amountCents: z.number(), bookedOn: z.string(), method: z.string(), note: z.string().nullable(), status: z.enum(['confirmed', 'reversed']) });
export const dunningDto = z.object({ level: z.number(), label: z.string(), feeCents: z.number(), at: z.string(), feeInvoiceId: z.uuid().nullable() });

export const invoiceListItem = z.object({
  id: z.uuid(),
  number: z.string().nullable(),
  kind: z.enum(['membership', 'other', 'credit_note', 'cancellation', 'dunning_fee']),
  status: z.enum(['draft', 'issued', 'open', 'partially_paid', 'paid', 'cancelled', 'written_off']),
  recipientName: z.string(),
  memberId: z.uuid().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  totalCents: z.number(),
  openCents: z.number(),
  overdue: z.boolean(),
  dunningLevel: z.number(),
});
export type InvoiceListItem = z.infer<typeof invoiceListItem>;

export const invoiceDetail = invoiceListItem.extend({
  coverText: z.string().nullable(),
  recipient: z.object({ name: z.string(), lines: z.array(z.string()) }).nullable(),
  lines: z.array(invoiceLine),
  allocations: z.array(allocationDto),
  dunning: z.array(dunningDto),
  cancelsInvoice: z.object({ id: z.uuid(), number: z.string().nullable() }).nullable(),
  cancelledBy: z.object({ id: z.uuid(), number: z.string().nullable() }).nullable(),
  pdfSha256: z.string().nullable(),
  writtenOffReason: z.string().nullable(),
  dunningHoldUntil: z.string().nullable(),
  dunningHoldReason: z.string().nullable(),
});
export type InvoiceDetail = z.infer<typeof invoiceDetail>;

export const invoiceQuery = z.object({
  status: z.enum(['draft', 'open', 'overdue', 'paid', 'cancelled', 'written_off', 'all']).default('all'),
  memberId: z.uuid().optional(),
  feeRunId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const paymentInput = z.object({
  amountCents: cents.refine((c) => c > 0, 'Betrag muss größer als 0 sein.'),
  bookedOn: z.iso.date(),
  method: z.enum(['cash', 'transfer', 'direct_debit', 'other']),
  note: z.string().trim().max(200).nullish(),
});

export const dunningProposal = z.object({ invoice: invoiceListItem, nextLevel: z.number(), label: z.string(), feeCents: z.number(), daysOverdue: z.number() });
