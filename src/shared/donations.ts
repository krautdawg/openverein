import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

export const donationSettings = z.object({
  kind: z.enum(['freistellung', 'feststellung']).nullable(),
  office: text(120).nullable(),
  taxNumber: text(40).nullable(),
  date: z.iso.date().nullable(),
  period: text(40).nullable(),
  purposes: text(500).nullable(),
  signer: text(120).nullable(),
});
export type DonationSettings = z.infer<typeof donationSettings>;

export const donorInput = z.object({
  kind: z.enum(['natural', 'organisation']).default('natural'),
  firstName: text(100).nullable().optional(),
  lastName: text(100).nullable().optional(),
  companyName: text(200).nullable().optional(),
  street: text(200),
  postalCode: text(10),
  city: text(100),
  email: z.email().nullable().optional(),
});

export const donationInput = z
  .object({
    personId: z.uuid().optional(),
    donor: donorInput.optional(),
    date: z.iso.date(),
    amountCents: z.number().int().positive().max(100_000_000),
    waiver: z.boolean().default(false),
    note: z.string().trim().max(500).nullable().optional(),
    // Posts the donation to the ledger; leave out when it is already booked (e.g. through the bank).
    moneyAccountId: z.uuid().nullable().optional(),
    incomeAccountId: z.uuid().nullable().optional(),
  })
  .refine((d) => !!d.personId !== !!d.donor, { message: 'Entweder eine vorhandene Person oder neue Angaben.', path: ['personId'] });

export const donation = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  donorName: z.string(),
  date: z.string(),
  amountCents: z.number(),
  waiver: z.boolean(),
  note: z.string().nullable(),
  journalNumber: z.number().nullable(),
  receipt: z.object({ id: z.uuid(), number: z.string() }).nullable(),
});
export type Donation = z.infer<typeof donation>;

export const receipt = z.object({
  id: z.uuid(),
  number: z.string(),
  kind: z.enum(['single', 'collective']),
  personId: z.uuid(),
  donorName: z.string(),
  issuedOn: z.string(),
  totalCents: z.number(),
  status: z.enum(['issued', 'cancelled']),
  cancelReason: z.string().nullable(),
  donationCount: z.number(),
});
export type Receipt = z.infer<typeof receipt>;
