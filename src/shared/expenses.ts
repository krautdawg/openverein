import { z } from 'zod';
import { isValidIban, normalizeIban } from './iban.ts';

export const EXPENSE_STATUS_LABEL = { submitted: 'Eingereicht', approved: 'Angenommen', rejected: 'Abgelehnt' } as const;

export const expenseClaimInput = z.object({
  memberId: z.uuid(),
  purpose: z.string().trim().min(1, 'Wofür war die Ausgabe?').max(200),
  spentOn: z.iso.date(),
  amountCents: z.number().int().positive().max(10_000_000),
  accountHolder: z.string().trim().min(1, 'Kontoinhaber:in fehlt.').max(70),
  iban: z.string().transform(normalizeIban).refine(isValidIban, 'Diese IBAN ist nicht gültig.'),
  fileId: z.uuid(),
});

export const expenseClaim = z.object({
  id: z.uuid(),
  memberId: z.uuid(),
  name: z.string(),
  purpose: z.string(),
  spentOn: z.string(),
  amountCents: z.number(),
  accountHolder: z.string(),
  /** full IBAN only for users who may see IBANs; otherwise the last four digits */
  iban: z.string(),
  status: z.enum(['submitted', 'approved', 'rejected']),
  receiptId: z.uuid().nullable(),
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
});
export type ExpenseClaim = z.infer<typeof expenseClaim>;
