import { z } from 'zod';
import { lineInput } from './invoices.ts';

export const OFFER_STATUS_LABEL = { draft: 'Entwurf', sent: 'Verschickt', accepted: 'Angenommen', declined: 'Abgelehnt', converted: 'In Rechnung' } as const;
export type OfferStatus = keyof typeof OFFER_STATUS_LABEL;

export const offerCreate = z.object({
  memberId: z.uuid(),
  validUntil: z.iso.date().nullish(),
  coverText: z.string().trim().max(2000).nullish(),
  closingText: z.string().trim().max(2000).nullish(),
  lines: z.array(lineInput).min(1, 'Mindestens eine Position.').max(200),
});
export const offerPatch = offerCreate.omit({ memberId: true }).partial();

export const offer = z.object({
  id: z.uuid(),
  number: z.string().nullable(),
  status: z.enum(['draft', 'sent', 'accepted', 'declined', 'converted']),
  memberId: z.uuid(),
  recipientName: z.string(),
  issueDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  expired: z.boolean(),
  coverText: z.string().nullable(),
  closingText: z.string().nullable(),
  totalCents: z.number(),
  invoiceId: z.uuid().nullable(),
  lines: z.array(z.object({ position: z.number(), text: z.string(), quantity: z.number(), unitCents: z.number(), totalCents: z.number(), taxRate: z.number() })),
  createdAt: z.string(),
});
export type Offer = z.infer<typeof offer>;
