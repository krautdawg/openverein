import { PAYMENT_METHODS } from './fees.ts';
import { z } from 'zod';

export const MEMBER_STATUSES = ['applicant', 'future', 'active', 'resigned', 'former', 'rejected'] as const;
export const memberStatus = z.enum(MEMBER_STATUSES);
export type MemberStatus = z.infer<typeof memberStatus>;

export const STATUS_LABEL: Record<MemberStatus, string> = {
  applicant: 'Antrag',
  future: 'Künftig',
  active: 'Aktiv',
  resigned: 'Gekündigt',
  former: 'Ehemalig',
  rejected: 'Abgelehnt',
};

export const date = z.iso.date('Bitte ein Datum im Format JJJJ-MM-TT angeben.');
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const POSTAL: Record<string, RegExp> = { DE: /^\d{5}$/, AT: /^\d{4}$/, CH: /^\d{4}$/ };

export function postalCodeProblem(postalCode: string | null | undefined, country: string | null | undefined) {
  const re = POSTAL[country ?? 'DE'];
  if (!postalCode || !re || re.test(postalCode)) return null;
  return (country ?? 'DE') === 'DE' ? 'Die PLZ hat in Deutschland 5 Ziffern.' : 'Die PLZ hat in Österreich und der Schweiz 4 Ziffern.';
}

/** Person fields shared by create and update. Restricted fields may be absent in responses. */
const personBase = z.object({
  kind: z.enum(['natural', 'organisation']),
  firstName: optText(100),
  lastName: optText(100),
  companyName: optText(200),
  birthDate: date.nullish(),
  email: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(254).nullish().or(z.literal('').transform(() => null)),
  phone: optText(50),
  street: optText(200),
  postalCode: optText(20),
  city: optText(100),
  country: z.string().length(2).toUpperCase(),
  preferredChannel: z.enum(['email', 'letter', 'none']),
  note: optText(4000),
  /** e-invoice (XRechnung) for business or public recipients */
  einvoiceFormat: z.enum(['none', 'xrechnung']).optional(),
  buyerReference: optText(100).optional(),
  einvoiceAddress: optText(200).optional(),
  vatId: z.preprocess((v) => (typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v), z.string().regex(/^[A-Z]{2}[A-Z0-9]{2,13}$/, 'Format: Länderkürzel und Nummer, z. B. DE123456789.').nullish().or(z.literal('').transform(() => null))).optional(),
});

/** For create: with defaults. For patch, personBase.partial() keeps absent fields absent. */
export const personFields = personBase.extend({
  kind: personBase.shape.kind.default('natural'),
  country: personBase.shape.country.default('DE'),
  preferredChannel: personBase.shape.preferredChannel.default('email'),
});

function checkPerson(p: { kind?: string; lastName?: string | null; companyName?: string | null; postalCode?: string | null; country?: string }, ctx: z.RefinementCtx, partial = false) {
  if (!partial || p.kind !== undefined) {
    if (p.kind === 'organisation' ? !p.companyName : !p.lastName) {
      ctx.addIssue({ code: 'custom', path: [p.kind === 'organisation' ? 'companyName' : 'lastName'], message: 'Pflichtfeld.' });
    }
  }
  // On partial updates without a country, the route checks against the stored country.
  if (partial && p.country === undefined) return;
  const problem = postalCodeProblem(p.postalCode, p.country);
  if (problem) ctx.addIssue({ code: 'custom', path: ['postalCode'], message: problem });
}

export const memberCreate = personFields
  .extend({
    joinDate: date.nullish(),
    applicationDate: date.nullish(),
    membershipNumber: z.string().trim().min(1).max(40).optional(),
    groupIds: z.array(z.uuid()).max(50).default([]),
    /** custom field values by field id */
    custom: z.record(z.uuid(), z.unknown()).optional(),
  })
  .superRefine((v, ctx) => checkPerson(v, ctx));
export type MemberCreate = z.input<typeof memberCreate>;

/** Status is not editable here; it only changes through the transition actions. */
export const memberPatch = personBase
  .partial()
  .extend({
    joinDate: date.optional(),
    applicationDate: date.nullish(),
    custom: z.record(z.uuid(), z.unknown()).optional(),
    status: z.unknown().refine(() => false, 'Der Status ändert sich nur über Aktionen: resign, withdraw-resignation, admit, reject.').optional(),
  })
  .strict()
  .superRefine((v, ctx) => checkPerson(v, ctx, true));

export const resignBody = z.object({
  noticeDate: date,
  exitDate: date,
  exitReason: optText(200),
});

export const groupRef = z.object({ id: z.uuid(), name: z.string(), shortCode: z.string(), color: z.string() });

export const memberListItem = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  membershipNumber: z.string(),
  status: memberStatus,
  kind: z.enum(['natural', 'organisation']),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  companyName: z.string().nullable(),
  email: z.string().nullable().optional(),
  city: z.string().nullable(),
  joinDate: z.string().nullable(),
  exitDate: z.string().nullable(),
  groups: z.array(groupRef),
});
export type MemberListItem = z.infer<typeof memberListItem>;

export const membership = z.object({
  id: z.uuid(),
  groupId: z.uuid(),
  groupName: z.string(),
  color: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});
export type Membership = z.infer<typeof membership>;

export const timelineEntry = z.object({ at: z.string(), action: z.string(), actor: z.string(), diff: z.unknown() });

export const memberDetail = memberListItem.extend({
  birthDate: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  street: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
  preferredChannel: z.enum(['email', 'letter', 'none']),
  note: z.string().nullable().optional(),
  applicationDate: z.string().nullable(),
  noticeDate: z.string().nullable(),
  exitReason: z.string().nullable(),
  memberships: z.array(membership),
  timeline: z.array(timelineEntry),
  warnings: z.array(z.string()),
  /** fields hidden for this user by their role */
  restricted: z.array(z.string()),
  /** custom field values the user may see, by field id */
  custom: z.record(z.string(), z.unknown()),
  /** send back as If-Match when changing the record (412 when someone changed it meanwhile) */
  version: z.string(),
  einvoice: z.object({ format: z.enum(['none', 'xrechnung']), buyerReference: z.string().nullable(), address: z.string().nullable(), vatId: z.string().nullable() }),
});
export type MemberDetail = z.infer<typeof memberDetail>;

export const memberListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.union([memberStatus, z.array(memberStatus)]).optional(),
  groupId: z.uuid().optional(),
  includeFormer: z.stringbool().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  ageFrom: z.coerce.number().int().min(0).max(120).optional(),
  ageTo: z.coerce.number().int().min(0).max(120).optional(),
  joinFrom: date.optional(),
  joinTo: date.optional(),
  exitFrom: date.optional(),
  exitTo: date.optional(),
  /** active SEPA mandate or none */
  mandate: z.enum(['active', 'none']).optional(),
  household: z.enum(['yes', 'no']).optional(),
  /** open receivables (open or partly paid invoices) */
  openBalance: z.stringbool().optional(),
  /** one custom field filter: `<field id>:<value>` (text matches partly, others exactly) */
  cf: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.{1,100}$/, 'Format: <Feld-ID>:<Wert>').optional(),
  sort: z.enum(['name', 'number', 'joinDate']).default('name'),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const memberList = z.object({ items: z.array(memberListItem), total: z.number(), nextCursor: z.string().nullable() });

export const bulkBody = z.object({
  ids: z.array(z.uuid()).min(1).max(5000),
  action: z.enum(['add_to_group', 'end_group']),
  groupId: z.uuid(),
  date,
});
export const bulkResult = z.object({
  succeeded: z.number(),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export function displayName(m: { kind: string; firstName?: string | null; lastName?: string | null; companyName?: string | null }) {
  if (m.kind === 'organisation') return m.companyName ?? '';
  return [m.lastName, m.firstName].filter(Boolean).join(', ');
}
