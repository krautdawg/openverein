import { z } from 'zod';

export const COURT_COLORS = ['blau', 'gruen', 'rot', 'gelb', 'orange', 'tuerkis', 'grau', 'schwarz'] as const;
export const COLOR_LABEL: Record<(typeof COURT_COLORS)[number], string> = {
  blau: 'Blau', gruen: 'Grün', rot: 'Rot', gelb: 'Gelb', orange: 'Orange', tuerkis: 'Türkis', grau: 'Grau', schwarz: 'Schwarz',
};
export const GROUP_KINDS = ['division', 'segment', 'board', 'team'] as const;
export const KIND_LABEL: Record<(typeof GROUP_KINDS)[number], string> = { division: 'Abteilung', segment: 'Gruppe', board: 'Vorstand', team: 'Mannschaft' };

export const groupFields = z.object({
  name: z.string().trim().min(1, 'Pflichtfeld.').max(120),
  shortCode: z.string().trim().min(1, 'Pflichtfeld.').max(20).regex(/^[\p{L}\p{N}_-]+$/u, 'Nur Buchstaben, Ziffern, - und _.'),
  kind: z.enum(GROUP_KINDS).default('segment'),
  color: z.enum(COURT_COLORS).default('blau'),
  parentId: z.uuid().nullish(),
  visibleToMembers: z.boolean().default(true),
  inApplicationForm: z.boolean().default(false),
});

export const groupPatch = groupFields.partial();

export const group = z.object({
  id: z.uuid(),
  name: z.string(),
  shortCode: z.string(),
  kind: z.enum(GROUP_KINDS),
  color: z.string(),
  parentId: z.uuid().nullable(),
  visibleToMembers: z.boolean(),
  inApplicationForm: z.boolean(),
  archived: z.boolean(),
  memberCount: z.number(),
});
export type Group = z.infer<typeof group>;

export const membershipCreate = z.object({
  memberId: z.uuid(),
  groupId: z.uuid(),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullish(),
});
export const membershipPatch = z.object({ validTo: z.iso.date().nullable() });
