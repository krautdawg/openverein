import { z } from 'zod';

export const PARTICIPATION_LABEL = { yes: 'Zusage', maybe: 'Vielleicht', no: 'Absage', waitlist: 'Warteliste', attended: 'Anwesend', not_attended: 'Nicht da' } as const;
export const participationStatus = z.enum(['yes', 'maybe', 'no', 'waitlist', 'attended', 'not_attended']);

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Datum und Uhrzeit im Format JJJJ-MM-TTTHH:MM.');

export const calendarInput = z.object({
  name: z.string().trim().min(1, 'Pflichtfeld.').max(80),
  color: z.string().max(20).default('blau'),
  groupIds: z.array(z.uuid()).min(1).max(100).nullish(),
});
export const calendar = z.object({ id: z.uuid(), name: z.string(), color: z.string(), groupIds: z.array(z.uuid()).nullable(), hasFeed: z.boolean() });
export type Calendar = z.infer<typeof calendar>;

export const recurrenceInput = z.object({
  freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  interval: z.number().int().min(1).max(52).default(1),
  byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).max(7).default([]),
  until: z.iso.date().nullish(),
  count: z.number().int().min(1).max(1000).nullish(),
});

export const eventInput = z.object({
  calendarId: z.uuid(),
  title: z.string().trim().min(1, 'Pflichtfeld.').max(200),
  description: z.string().trim().max(5000).nullish(),
  location: z.string().trim().max(200).nullish(),
  startsAt: localDateTime,
  endsAt: localDateTime,
  allDay: z.boolean().default(false),
  recurrence: recurrenceInput.nullish(),
  maxParticipants: z.number().int().min(1).max(100_000).nullish(),
  rsvp: z.boolean().default(true),
  registrationClosesHours: z.number().int().min(0).max(720).nullish(),
  priceCents: z.number().int().min(0).max(10_000_000).nullish(),
});

/** Changes to a recurring event apply to one occurrence, this and the following ones, or the whole series. */
export const eventPatch = eventInput.partial().extend({ scope: z.enum(['this', 'following', 'all']).default('all'), date: z.iso.date().optional() });

export const occurrence = z.object({
  eventId: z.uuid(),
  date: z.iso.date(),
  title: z.string(),
  calendarId: z.uuid(),
  calendarName: z.string(),
  color: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  allDay: z.boolean(),
  location: z.string().nullable(),
  recurring: z.boolean(),
  maxParticipants: z.number().nullable(),
  counts: z.object({ yes: z.number(), maybe: z.number(), no: z.number(), waitlist: z.number(), attended: z.number() }),
});
export type Occurrence = z.infer<typeof occurrence>;

export const participant = z.object({ memberId: z.uuid(), name: z.string(), status: participationStatus, invoiceId: z.uuid().nullable(), updatedAt: z.string() });
export const occurrenceDetail = occurrence.extend({
  description: z.string().nullable(),
  rrule: z.string().nullable(),
  seriesStart: z.string(),
  rsvp: z.boolean(),
  registrationClosesHours: z.number().nullable(),
  priceCents: z.number().nullable(),
  participants: z.array(participant),
});
export type OccurrenceDetail = z.infer<typeof occurrenceDetail>;

export const rsvpInput = z.object({ status: participationStatus });
export const birthday = z.object({ memberId: z.uuid(), name: z.string(), date: z.iso.date(), age: z.number() });
