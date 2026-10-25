import { z } from 'zod';
import { bookingLine } from './ledger.ts';

export const RECEIPT_STATUS_LABEL = { open: 'offen', paid: 'bezahlt', void: 'ungültig' } as const;

const receiptLine = bookingLine.extend({ grossCents: z.number().int().positive().max(100_000_000) });

export const receiptInput = z.object({
  supplier: z.string().trim().min(1).max(200),
  number: z.string().trim().max(100).transform((v) => v || null).nullish(),
  receiptDate: z.iso.date(),
  dueDate: z.iso.date().nullish(),
  fileId: z.uuid().nullish(),
  note: z.string().trim().max(1000).nullish(),
  lines: z.array(receiptLine).min(1).max(50),
  /** pay at once (cash on the spot, or already paid by card) */
  pay: z.object({ date: z.iso.date(), moneyAccountId: z.uuid() }).nullish(),
});

export const selfIssuedInput = z.object({
  date: z.iso.date(),
  payee: z.string().trim().min(2).max(200),
  reason: z.string().trim().min(10, 'Bitte begründe, warum es keinen Beleg gibt.').max(500),
  text: z.string().trim().min(1).max(200),
  amountCents: z.number().int().positive().max(100_000_000),
  accountId: z.uuid(),
  signer: z.string().trim().min(3).max(120),
  pay: z.object({ date: z.iso.date(), moneyAccountId: z.uuid() }).nullish(),
});

export const receipt = z.object({
  id: z.uuid(),
  supplier: z.string(),
  number: z.string().nullable(),
  receiptDate: z.string(),
  dueDate: z.string().nullable(),
  status: z.enum(['open', 'paid', 'void']),
  totalCents: z.number(),
  selfIssued: z.boolean(),
  hasFile: z.boolean(),
  paidOn: z.string().nullable(),
  journalNumber: z.number().nullable(),
  lines: z.array(z.object({ text: z.string().nullable(), grossCents: z.number(), accountNumber: z.string(), accountName: z.string(), taxRate: z.string().nullable() })),
  note: z.string().nullable(),
  voidReason: z.string().nullable(),
});
export type Receipt = z.infer<typeof receipt>;

export const cashBook = z.object({
  account: z.object({ id: z.uuid(), number: z.string(), name: z.string() }),
  from: z.string(),
  to: z.string(),
  openingCents: z.number(),
  rows: z.array(z.object({ entryNumber: z.number(), date: z.string(), text: z.string(), inCents: z.number(), outCents: z.number(), balanceCents: z.number(), receiptId: z.uuid().nullable(), receiptHasFile: z.boolean() })),
  closingCents: z.number(),
});
