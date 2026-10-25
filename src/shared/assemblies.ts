import { z } from 'zod';

export const assemblyItemInput = z.object({
  title: z.string().trim().min(1, 'Titel des Punktes fehlt.').max(200),
  description: z.string().trim().max(2000).nullish(),
  isVote: z.boolean().default(false),
});

export const assemblyInput = z.object({
  title: z.string().trim().min(1, 'Pflichtfeld.').max(200),
  heldOn: z.iso.date(),
  startsAt: z.string().regex(/^[0-2]\d:[0-5]\d$/, 'Uhrzeit wie 19:30.'),
  place: z.string().trim().min(1, 'Pflichtfeld.').max(300),
  noticeDays: z.number().int().min(0).max(120).default(14),
  items: z.array(assemblyItemInput).min(1, 'Mindestens ein Tagesordnungspunkt.').max(40),
});

export const assemblyItem = assemblyItemInput.extend({
  id: z.uuid(),
  position: z.number(),
  description: z.string().nullable(),
  votesYes: z.number().nullable(),
  votesNo: z.number().nullable(),
  votesAbstain: z.number().nullable(),
  outcome: z.string().nullable(),
});

export const assembly = z.object({
  id: z.uuid(),
  title: z.string(),
  heldOn: z.string(),
  startsAt: z.string(),
  place: z.string(),
  noticeDays: z.number(),
  /** last day the invitation may go out to keep the notice period */
  inviteBy: z.string(),
  chair: z.string().nullable(),
  minutesBy: z.string().nullable(),
  invitedAt: z.string().nullable(),
  messageId: z.uuid().nullable(),
  closedAt: z.string().nullable(),
  items: z.array(assemblyItem),
  attendees: z.array(z.uuid()),
  /** current members on the day of the assembly */
  eligible: z.number(),
});
export type Assembly = z.infer<typeof assembly>;
