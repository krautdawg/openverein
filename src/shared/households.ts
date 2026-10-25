import { z } from 'zod';

export const HOUSEHOLD_RULE_KINDS = ['none', 'percent', 'cap', 'children_free'] as const;
export const HOUSEHOLD_RULE_LABEL = { none: 'Kein Rabatt', percent: 'Prozent-Rabatt', cap: 'Höchstbetrag', children_free: 'Kinder frei' } as const;

export const householdInput = z.object({
  name: z.string().trim().min(1).max(100),
  payerPersonId: z.uuid(),
  memberIds: z.array(z.uuid()).max(30).default([]),
});

export const householdRuleInput = z
  .object({
    validFrom: z.iso.date(),
    kind: z.enum(HOUSEHOLD_RULE_KINDS),
    fromNth: z.number().int().min(2).max(20).nullish(),
    percentBp: z.number().int().min(1).max(10_000).nullish(),
    capCents: z.number().int().min(0).max(10_000_000).nullish(),
  })
  .refine((r) => r.kind !== 'percent' || (r.fromNth && r.percentBp), { message: 'Prozent und ab welchem Mitglied angeben.', path: ['percentBp'] })
  .refine((r) => r.kind !== 'cap' || r.capCents !== undefined && r.capCents !== null, { message: 'Höchstbetrag angeben.', path: ['capCents'] })
  .refine((r) => r.kind !== 'children_free' || r.fromNth, { message: 'Ab welchem Kind angeben.', path: ['fromNth'] });

export const household = z.object({
  id: z.uuid(),
  name: z.string(),
  payerPersonId: z.uuid(),
  payerName: z.string(),
  members: z.array(z.object({ memberId: z.uuid(), personId: z.uuid(), name: z.string(), membershipNumber: z.string(), status: z.string(), birthDate: z.string().nullable() })),
  rules: z.array(z.object({ id: z.uuid(), validFrom: z.string(), kind: z.enum(HOUSEHOLD_RULE_KINDS), fromNth: z.number().nullable(), percentBp: z.number().nullable(), capCents: z.number().nullable(), label: z.string() })),
  currentRule: z.string(),
});
export type Household = z.infer<typeof household>;
