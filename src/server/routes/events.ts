import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { birthday, calendar, calendarInput, eventInput, eventPatch, occurrence, occurrenceDetail, rsvpInput, type Occurrence } from '../../shared/events.ts';
import { displayName } from '../../shared/members.ts';
import { formatRule, occurrences, parseRule } from '../../shared/recurrence.ts';
import { audit } from '../audit.ts';
import { requireActor, sha256 } from '../auth/session.ts';
import type { Db, EventTable, ParticipationStatus } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { cancelInvoice, createDraft, issueInvoice } from '../invoices/service.ts';
import { applyScope, loadMemberRow, orgToday } from '../members/query.ts';
import { requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';

const idParam = z.object({ id: z.uuid() });
const tags = ['events'];
type Ev = Selectable<EventTable>;

const toLocal = (s: string) => s.replace('T', ' ') + (s.length === 16 ? ':00' : '');
const fromLocal = (s: string) => s.slice(0, 16).replace(' ', 'T');
const datePart = (s: string) => s.slice(0, 10);
const shiftTo = (ts: string, date: string) => `${date} ${ts.slice(11)}`;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function rruleOf(r: z.infer<typeof eventInput>['recurrence']) {
  if (!r) return null;
  return formatRule({ freq: r.freq, interval: r.interval, byDay: r.freq === 'WEEKLY' ? r.byDay : [], until: r.until ?? null, count: r.count ?? null });
}

/** Wall-clock "now" in the club's time zone as 'YYYY-MM-DD HH:MM'. */
async function localNow(db: Db, organizationId: string) {
  const org = await db.selectFrom('organization').select('time_zone').where('id', '=', organizationId).executeTakeFirstOrThrow();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: org.time_zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return { now: parts.replace(',', ''), timeZone: org.time_zone };
}

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** Calendars the actor may see: all when unscoped, otherwise calendars for everyone or for one of their groups. */
  async function visibleCalendars(actor: Actor) {
    const rows = await db.selectFrom('calendar').selectAll().where('organization_id', '=', actor.organizationId).orderBy('name').execute();
    const scope = scopeOf(actor, 'events', 'read');
    return scope === null ? rows : rows.filter((c) => !c.group_ids || c.group_ids.some((g) => scope.includes(g)));
  }

  /** A calendar the actor may put events into: visible, and for scoped actors one of their groups' calendars. */
  async function writableCalendar(actor: Actor, calendarId: string) {
    const cal = (await visibleCalendars(actor)).find((c) => c.id === calendarId);
    if (!cal) throw notFound('Kalender');
    const scope = scopeOf(actor, 'events', 'write');
    if (scope !== null && (!cal.group_ids || !cal.group_ids.some((g) => scope.includes(g)))) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Dieser Kalender gehört nicht zu Deinen Gruppen.', { permission: 'events:write' });
    return cal;
  }

  async function loadEvent(actor: Actor, id: string, mode: 'read' | 'write' = 'read') {
    const e = await db.selectFrom('event').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!e) throw notFound('Termin');
    const cals = await visibleCalendars(actor);
    const cal = cals.find((c) => c.id === e.calendar_id);
    if (!cal) throw notFound('Termin');
    if (mode === 'write') await writableCalendar(actor, cal.id);
    return { e, cal };
  }

  function assertOccurrence(e: Ev, date: string) {
    if (occurrences(datePart(e.starts_at), e.rrule, date, date, e.exdates).length === 0) throw new Problem(404, 'not-found', 'An diesem Tag findet der Termin nicht statt.');
  }

  async function counts(eventIds: string[], from: string, to: string) {
    if (!eventIds.length) return new Map<string, Occurrence['counts']>();
    const rows = await db.selectFrom('participation').select(['event_id', 'occurrence_date', 'status', sql<number>`count(*)::int`.as('n')]).where('event_id', 'in', eventIds).where('occurrence_date', '>=', from).where('occurrence_date', '<=', to).groupBy(['event_id', 'occurrence_date', 'status']).execute();
    const map = new Map<string, Occurrence['counts']>();
    for (const r of rows) {
      const key = `${r.event_id}|${r.occurrence_date}`;
      const c = map.get(key) ?? { yes: 0, maybe: 0, no: 0, waitlist: 0, attended: 0 };
      if (r.status in c) c[r.status as keyof typeof c] += r.n;
      map.set(key, c);
    }
    return map;
  }

  function toOccurrence(e: Ev, cal: { name: string; color: string }, date: string, c: Occurrence['counts'] | undefined): Occurrence {
    const shift = dayDiff(datePart(e.starts_at), date);
    return {
      eventId: e.id,
      date,
      title: e.title,
      calendarId: e.calendar_id,
      calendarName: cal.name,
      color: cal.color,
      startsAt: fromLocal(shiftTo(e.starts_at, date)),
      endsAt: fromLocal(shiftTo(e.ends_at, addDays(datePart(e.ends_at), shift))),
      allDay: e.all_day,
      location: e.location,
      recurring: !!e.rrule,
      maxParticipants: e.max_participants,
      counts: c ?? { yes: 0, maybe: 0, no: 0, waitlist: 0, attended: 0 },
    };
  }

  // ---------- Calendars ----------

  app.get('/calendars', { schema: { tags, summary: 'Kalender', response: { 200: z.array(calendar) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'events', 'read');
    return (await visibleCalendars(actor)).map((c) => ({ id: c.id, name: c.name, color: c.color, groupIds: c.group_ids, hasFeed: !!c.feed_token_hash, public: c.public, publicOrigins: c.public_origins }));
  });

  app.post('/calendars', { schema: { tags, summary: 'Kalender anlegen', body: calendarInput, response: { 201: calendar } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'events', 'write');
    if (scopeOf(actor, 'events', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Kalender legen Zugänge für den ganzen Verein an.', { permission: 'events:write (ganzer Verein)' });
    const c = await db.transaction().execute(async (tx) => {
      const c = await tx.insertInto('calendar').values({ organization_id: actor.organizationId, name: req.body.name, color: req.body.color, group_ids: req.body.groupIds ?? null }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'calendar.created', entityType: 'calendar', entityId: c.id, diff: { name: [null, c.name] } });
      return c;
    });
    reply.status(201);
    return { id: c.id, name: c.name, color: c.color, groupIds: c.group_ids, hasFeed: false, public: c.public, publicOrigins: c.public_origins };
  });

  app.patch('/calendars/:id', { schema: { tags, summary: 'Kalender ändern', params: idParam, body: calendarInput.partial(), response: { 200: calendar } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'events', 'write');
    if (scopeOf(actor, 'events', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', undefined, { permission: 'events:write (ganzer Verein)' });
    const c = await db.transaction().execute(async (tx) => {
      const c = await tx
        .updateTable('calendar')
        .set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.color ? { color: req.body.color } : {}), ...(req.body.groupIds !== undefined ? { group_ids: req.body.groupIds ?? null } : {}), ...(req.body.public !== undefined ? { public: req.body.public } : {}), ...(req.body.publicOrigins ? { public_origins: req.body.publicOrigins.map((o) => o.toLowerCase()) } : {}) })
        .where('id', '=', req.params.id)
        .where('organization_id', '=', actor.organizationId)
        .returningAll()
        .executeTakeFirst();
      if (!c) throw notFound('Kalender');
      // A calendar limited to groups (e.g. the board) is not for the public.
      if (c.public && c.group_ids) throw new Problem(409, 'not-public', 'Ein Kalender nur für bestimmte Gruppen kann nicht öffentlich sein.');
      await audit(tx, actor.organizationId, actor, { action: 'calendar.updated', entityType: 'calendar', entityId: c.id, diff: { public: [null, req.body.public ?? null], publicOrigins: [null, req.body.publicOrigins ?? null] } });
      return c;
    });
    return { id: c.id, name: c.name, color: c.color, groupIds: c.group_ids, hasFeed: !!c.feed_token_hash, public: c.public, publicOrigins: c.public_origins };
  });

  app.post('/calendars/:id/feed', { schema: { tags, summary: 'ICS-Abo-Link erzeugen; ein neuer Link macht den alten ungültig', params: idParam, body: z.object({}).optional(), response: { 200: z.object({ path: z.string() }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'events', 'write');
    if (scopeOf(actor, 'events', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Abo-Links verwalten Zugänge für den ganzen Verein.', { permission: 'events:write (ganzer Verein)' });
    const token = randomBytes(24).toString('base64url');
    await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('calendar').set({ feed_token_hash: sha256(token) }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw notFound('Kalender');
      await audit(tx, actor.organizationId, actor, { action: 'calendar.feed_rotated', entityType: 'calendar', entityId: req.params.id });
    });
    return { path: `/api/v1/ics/${token}.ics` };
  });

  app.get('/public/calendars/:id/events', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags, summary: 'Öffentlicher Kalender für die Website: Termine der nächsten Wochen (nur wenn der Kalender öffentlich ist)', security: [], params: idParam, querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }), response: { 200: z.object({ calendar: z.string(), club: z.string(), events: z.array(z.object({ title: z.string(), date: z.string(), startsAt: z.string(), endsAt: z.string(), allDay: z.boolean(), location: z.string().nullable() })) }) } } }, async (req) => {
    const cal = await db.selectFrom('calendar').innerJoin('organization', 'organization.id', 'calendar.organization_id').select(['calendar.id', 'calendar.name', 'calendar.organization_id', 'organization.name as club']).where('calendar.id', '=', req.params.id).where('calendar.public', '=', true).executeTakeFirst();
    if (!cal) throw notFound('Kalender');
    const from = (await localNow(db, cal.organization_id)).now.slice(0, 10);
    const to = addDays(from, req.query.days);
    const events = await db.selectFrom('event').select(['title', 'location', 'starts_at', 'ends_at', 'all_day', 'rrule', 'exdates']).where('calendar_id', '=', cal.id)
      .where(sql<boolean>`starts_at::date <= ${to}::date`).where((eb) => eb.or([eb('rrule', 'is not', null), eb(sql`ends_at::date`, '>=', from)])).execute();
    const out = events.flatMap((e) => (e.rrule ? occurrences(datePart(e.starts_at), e.rrule, from, to, e.exdates) : [datePart(e.starts_at)]).map((d) => ({
      // Only what a passer-by may see: no description, no participants.
      title: e.title, date: d, startsAt: `${d}T${e.starts_at.slice(11, 16)}`, endsAt: `${addDays(d, Math.round((Date.parse(e.ends_at.slice(0, 10)) - Date.parse(e.starts_at.slice(0, 10))) / 86_400_000))}T${e.ends_at.slice(11, 16)}`, allDay: e.all_day, location: e.location,
    })));
    return { calendar: cal.name, club: cal.club, events: out.sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 200) };
  });

  app.get('/ics/:token', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags, summary: 'Kalender als ICS-Abo (öffentlich über den geheimen Link)', security: [], params: z.object({ token: z.string().max(80) }) } }, async (req, reply) => {
    const token = req.params.token.replace(/\.ics$/, '');
    const cal = await db.selectFrom('calendar').selectAll().where('feed_token_hash', '=', sha256(token)).executeTakeFirst();
    if (!cal) throw new Problem(404, 'not-found', 'Dieser Kalender-Link ist ungültig oder wurde erneuert.');
    const org = await db.selectFrom('organization').select(['name', 'time_zone']).where('id', '=', cal.organization_id).executeTakeFirstOrThrow();
    const events = await db.selectFrom('event').selectAll().where('calendar_id', '=', cal.id).execute();
    reply.header('content-type', 'text/calendar; charset=utf-8').header('cache-control', 'private, max-age=900');
    return ics(`${org.name}: ${cal.name}`, org.time_zone, events);
  });

  // ---------- Events ----------

  app.get(
    '/events',
    { schema: { tags, summary: 'Termine in einem Zeitraum (Serien aufgelöst)', querystring: z.object({ from: z.iso.date(), to: z.iso.date(), calendarId: z.uuid().optional() }), response: { 200: z.array(occurrence) } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'events', 'read');
      const { from, to } = req.query;
      if (dayDiff(from, to) > 400 || to < from) throw new Problem(400, 'range', 'Bitte höchstens ein gutes Jahr auf einmal abfragen.');
      const cals = (await visibleCalendars(actor)).filter((c) => !req.query.calendarId || c.id === req.query.calendarId);
      if (!cals.length) return [];
      const events = await db
        .selectFrom('event')
        .selectAll()
        .where('calendar_id', 'in', cals.map((c) => c.id))
        .where(sql<boolean>`starts_at::date <= ${to}::date`)
        .where((eb) => eb.or([eb('rrule', 'is not', null), eb(sql`ends_at::date`, '>=', from)]))
        .execute();
      const c = await counts(events.map((e) => e.id), from, to);
      const out: Occurrence[] = [];
      for (const e of events) {
        const cal = cals.find((x) => x.id === e.calendar_id)!;
        // Multi-day single events show from their first day when they overlap the window.
        const dates = e.rrule ? occurrences(datePart(e.starts_at), e.rrule, from, to, e.exdates) : [datePart(e.starts_at)];
        for (const d of dates) out.push(toOccurrence(e, cal, d, c.get(`${e.id}|${d}`)));
      }
      return out.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
    },
  );

  async function detail(actor: Actor, id: string, date: string) {
    const { e, cal } = await loadEvent(actor, id);
    assertOccurrence(e, date);
    const c = (await counts([e.id], date, date)).get(`${e.id}|${date}`);
    const people = await db
      .selectFrom('participation')
      .innerJoin('member', 'member.id', 'participation.member_id')
      .innerJoin('person', 'person.id', 'member.person_id')
      .select(['participation.member_id', 'participation.status', 'participation.invoice_id', 'participation.updated_at', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('participation.event_id', '=', e.id)
      .where('participation.occurrence_date', '=', date)
      .orderBy('participation.waitlisted_at', (ob) => ob.asc().nullsFirst())
      .orderBy('person.last_name')
      .execute();
    return {
      ...toOccurrence(e, cal, date, c),
      description: e.description,
      rrule: e.rrule,
      seriesStart: datePart(e.starts_at),
      rsvp: e.rsvp,
      registrationClosesHours: e.registration_closes_hours,
      priceCents: e.price_cents,
      participants: people.map((p) => ({ memberId: p.member_id, name: displayName({ kind: p.kind, firstName: p.first_name, lastName: p.last_name, companyName: p.company_name }), status: p.status, invoiceId: p.invoice_id, updatedAt: p.updated_at.toISOString() })),
    };
  }

  app.get('/events/:id/occurrences/:date', { schema: { tags, summary: 'Ein Termin an einem Tag mit Rückmeldungen', params: z.object({ id: z.uuid(), date: z.iso.date() }), response: { 200: occurrenceDetail } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'events', 'read');
    return detail(actor, req.params.id, req.params.date);
  });

  function validateTimes(startsAt: string, endsAt: string) {
    for (const [field, v] of [['startsAt', startsAt], ['endsAt', endsAt]] as const) {
      const t = `${v.slice(0, 10)}T${v.slice(11, 16)}`;
      if (Number.isNaN(Date.parse(`${t}:00Z`)) || new Date(`${t}:00Z`).toISOString().slice(0, 16) !== t) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field, message: 'Dieses Datum gibt es nicht.' }] });
    }
    if (endsAt < startsAt) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'endsAt', message: 'Das Ende liegt vor dem Beginn.' }] });
  }

  app.post('/events', { schema: { tags, summary: 'Termin oder Serie anlegen', body: eventInput, response: { 201: occurrenceDetail } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'events', 'write');
    const b = req.body;
    validateTimes(b.startsAt, b.endsAt);
    const cal = await writableCalendar(actor, b.calendarId);
    const rrule = ruleOrProblem(() => rruleOf(b.recurrence));
    // The series starts on its first real occurrence (a Monday-only series created on a Sunday starts on Monday),
    // so DTSTART in ICS feeds never adds a date the app does not show.
    const first = occurrences(b.startsAt.slice(0, 10), rrule, b.startsAt.slice(0, 10), addDays(b.startsAt.slice(0, 10), 400))[0];
    if (!first) throw new Problem(400, 'validation', 'Diese Wiederholung ergibt keinen einzigen Termin.');
    const shift = dayDiff(b.startsAt.slice(0, 10), first);
    const startsAt = shiftTo(toLocal(b.startsAt), first);
    const endsAt = shiftTo(toLocal(b.endsAt), addDays(b.endsAt.slice(0, 10), shift));
    const e = await db.transaction().execute(async (tx) => {
      const e = await tx
        .insertInto('event')
        .values({ organization_id: actor.organizationId, calendar_id: cal.id, title: b.title, description: b.description ?? null, location: b.location ?? null, starts_at: startsAt, ends_at: endsAt, all_day: b.allDay, rrule, max_participants: b.maxParticipants ?? null, rsvp: b.rsvp, registration_closes_hours: b.registrationClosesHours ?? null, price_cents: b.priceCents ?? null, created_by: actor.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'event.created', entityType: 'event', entityId: e.id, diff: { title: [null, e.title], startsAt: [null, e.starts_at], rrule: [null, rrule] } });
      return e;
    });
    reply.status(201);
    return detail(actor, e.id, first);
  });

  function ruleOrProblem<T>(f: () => T) {
    try {
      const r = f();
      if (typeof r === 'string') parseRule(r);
      return r;
    } catch (err) {
      throw new Problem(400, 'validation', 'Die Wiederholung ist ungültig.', (err as Error).message);
    }
  }

  /** Every participation of the event must still sit on one of its dates; otherwise RSVPs and invoices would vanish. */
  async function assertParticipationsFit(tx: Db, eventId: string) {
    const e = await tx.selectFrom('event').selectAll().where('id', '=', eventId).executeTakeFirstOrThrow();
    const dates = await tx.selectFrom('participation').select('occurrence_date').distinct().where('event_id', '=', eventId).execute();
    const lost = dates.filter((d) => occurrences(datePart(e.starts_at), e.rrule, d.occurrence_date, d.occurrence_date, e.exdates).length === 0);
    if (lost.length) throw new Problem(409, 'participations-left', 'Nach dieser Änderung hätten Rückmeldungen keinen Termin mehr.', `Betroffen: ${lost.map((d) => d.occurrence_date.split('-').reverse().join('.')).join(', ')}. Ändere stattdessen einzelne Termine oder sag sie ab.`);
    return e;
  }

  /** The date to show after an edit: the requested one if it still exists, else the first occurrence. */
  function landing(e: Ev, wanted: string | undefined) {
    if (wanted && occurrences(datePart(e.starts_at), e.rrule, wanted, wanted, e.exdates).length) return wanted;
    const first = occurrences(datePart(e.starts_at), e.rrule, datePart(e.starts_at), addDays(datePart(e.starts_at), 800), e.exdates)[0];
    if (!first) throw new Problem(400, 'validation', 'Diese Wiederholung ergibt keinen einzigen Termin.');
    return first;
  }

  /** Field values for an update: only what the body contains, times moved to `date` when given. */
  function changes(b: z.infer<typeof eventPatch>) {
    const v: Record<string, unknown> = {};
    if (b.calendarId) v.calendar_id = b.calendarId;
    if (b.title !== undefined) v.title = b.title;
    if (b.description !== undefined) v.description = b.description ?? null;
    if (b.location !== undefined) v.location = b.location ?? null;
    if (b.startsAt) v.starts_at = toLocal(b.startsAt);
    if (b.endsAt) v.ends_at = toLocal(b.endsAt);
    if (b.allDay !== undefined) v.all_day = b.allDay;
    if (b.maxParticipants !== undefined) v.max_participants = b.maxParticipants ?? null;
    if (b.rsvp !== undefined) v.rsvp = b.rsvp;
    if (b.registrationClosesHours !== undefined) v.registration_closes_hours = b.registrationClosesHours ?? null;
    if (b.priceCents !== undefined) v.price_cents = b.priceCents ?? null;
    if (b.recurrence !== undefined) v.rrule = ruleOrProblem(() => rruleOf(b.recurrence));
    return v;
  }

  app.patch(
    '/events/:id',
    { schema: { tags, summary: 'Termin ändern: nur diesen, diesen und alle folgenden, oder die ganze Serie', params: idParam, body: eventPatch, response: { 200: occurrenceDetail } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'events', 'write');
      const { e } = await loadEvent(actor, req.params.id, 'write');
      const b = req.body;
      const v = changes(b);
      if (b.calendarId) await writableCalendar(actor, b.calendarId);
      // "following" from the very first date is the whole series.
      const scope = e.rrule && b.scope === 'following' && b.date === datePart(e.starts_at) ? 'all' : b.scope;
      const result = await db.transaction().execute(async (tx) => {
        if (!e.rrule || scope === 'all') {
          const after = await tx.updateTable('event').set({ ...v, updated_at: new Date() }).where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
          validateTimes(after.starts_at, after.ends_at);
          await assertParticipationsFit(tx, e.id);
          await audit(tx, actor.organizationId, actor, { action: 'event.updated', entityType: 'event', entityId: e.id, diff: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, [(e as Record<string, unknown>)[k] ?? null, x]])) });
          return { id: e.id, date: landing(after, after.rrule ? b.date : undefined) };
        }
        if (!b.date) throw new Problem(400, 'validation', 'Für „nur diesen“ oder „ab diesem“ braucht es das Datum des Termins.');
        assertOccurrence(e, b.date);
        const base = { ...e, starts_at: shiftTo(e.starts_at, b.date), ends_at: shiftTo(e.ends_at, addDays(datePart(e.ends_at), dayDiff(datePart(e.starts_at), b.date))) };
        if (scope === 'this') {
          // The occurrence leaves the series as an exception and becomes a single event; its RSVPs move with it.
          await tx.updateTable('event').set({ exdates: sql`array_append(exdates, ${b.date}::date)`, updated_at: new Date() }).where('id', '=', e.id).execute();
          const single = await tx
            .insertInto('event')
            .values({ ...pick(base), rrule: null, exdates: [], ...v, organization_id: actor.organizationId, created_by: actor.userId } as never)
            .returningAll()
            .executeTakeFirstOrThrow();
          validateTimes(single.starts_at, single.ends_at);
          await tx.updateTable('participation').set({ event_id: single.id, occurrence_date: datePart(single.starts_at) }).where('event_id', '=', e.id).where('occurrence_date', '=', b.date).execute();
          await audit(tx, actor.organizationId, actor, { action: 'event.occurrence_changed', entityType: 'event', entityId: e.id, diff: { date: [null, b.date], newEvent: [null, single.id] } });
          return { id: single.id, date: datePart(single.starts_at) };
        }
        // "following": the old series ends the day before, a new series starts on this date.
        const rule = parseRule(e.rrule);
        const before = occurrences(datePart(e.starts_at), e.rrule, datePart(e.starts_at), addDays(b.date, -1), []).length;
        const oldRule = formatRule({ ...rule, until: addDays(b.date, -1), count: null });
        await tx.updateTable('event').set({ rrule: oldRule, updated_at: new Date() }).where('id', '=', e.id).execute();
        const newRule = 'rrule' in v ? (v.rrule as string | null) : formatRule({ ...rule, count: rule.count ? Math.max(1, rule.count - before) : null });
        const next = await tx
          .insertInto('event')
          .values({ ...pick(base), exdates: e.exdates.filter((x) => x >= b.date!), ...v, rrule: newRule, organization_id: actor.organizationId, created_by: actor.userId } as never)
          .returningAll()
          .executeTakeFirstOrThrow();
        validateTimes(next.starts_at, next.ends_at);
        await tx.updateTable('participation').set({ event_id: next.id }).where('event_id', '=', e.id).where('occurrence_date', '>=', b.date).execute();
        await assertParticipationsFit(tx, next.id);
        await audit(tx, actor.organizationId, actor, { action: 'event.series_split', entityType: 'event', entityId: e.id, diff: { from: [null, b.date], newEvent: [null, next.id] } });
        return { id: next.id, date: landing(next, b.date) };
      });
      return detail(actor, result.id, result.date);
    },
  );

  function pick(e: Ev) {
    return { calendar_id: e.calendar_id, title: e.title, description: e.description, location: e.location, starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, max_participants: e.max_participants, rsvp: e.rsvp, registration_closes_hours: e.registration_closes_hours, price_cents: e.price_cents };
  }

  app.delete(
    '/events/:id',
    { schema: { tags, summary: 'Termin absagen: nur diesen, diesen und alle folgenden, oder die ganze Serie', params: idParam, body: z.object({ scope: z.enum(['this', 'following', 'all']).default('all'), date: z.iso.date().optional() }).optional(), response: { 204: z.null() } } },
    async (req, reply) => {
      const actor = requireActor(req);
      requirePermission(actor, 'events', 'write');
      const { e } = await loadEvent(actor, req.params.id, 'write');
      const date = req.body?.date;
      const scope = req.body?.scope === 'following' && date === datePart(e.starts_at) ? 'all' : (req.body?.scope ?? 'all');
      await db.transaction().execute(async (tx) => {
        // Places already charged are cancelled with a cancellation invoice; paid ones must be refunded first (409).
        let billed = tx.selectFrom('participation').innerJoin('invoice', 'invoice.id', 'participation.invoice_id').select('invoice.id').where('participation.event_id', '=', e.id).where('invoice.status', '!=', 'cancelled');
        if (e.rrule && scope !== 'all' && date) billed = billed.where('participation.occurrence_date', scope === 'this' ? '=' : '>=', date);
        const today = await orgToday(tx, actor.organizationId);
        for (const inv of await billed.execute()) await cancelInvoice(tx, actor.organizationId, inv.id, today, actor.userId);
        if (!e.rrule || scope === 'all') {
          await tx.deleteFrom('event').where('id', '=', e.id).execute();
        } else {
          if (!date) throw new Problem(400, 'validation', 'Datum fehlt.');
          assertOccurrence(e, date);
          if (scope === 'this') await tx.updateTable('event').set({ exdates: sql`array_append(exdates, ${date}::date)` }).where('id', '=', e.id).execute();
          else await tx.updateTable('event').set({ rrule: formatRule({ ...parseRule(e.rrule), until: addDays(date, -1), count: null }) }).where('id', '=', e.id).execute();
          await tx.deleteFrom('participation').where('event_id', '=', e.id).where('occurrence_date', scope === 'this' ? '=' : '>=', date).execute();
        }
        await audit(tx, actor.organizationId, actor, { action: 'event.cancelled', entityType: 'event', entityId: e.id, diff: { scope: [null, scope], date: [null, date ?? null], title: [e.title, null] } });
      });
      reply.status(204);
      return null;
    },
  );

  // ---------- Participation ----------

  app.put(
    '/events/:id/occurrences/:date/participants/:memberId',
    { schema: { tags, summary: 'Rückmeldung oder Anwesenheit eintragen (mit Warteliste und Nachrücken)', params: z.object({ id: z.uuid(), date: z.iso.date(), memberId: z.uuid() }), body: rsvpInput, response: { 200: occurrenceDetail } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'events', 'write');
      const { e } = await loadEvent(actor, req.params.id, 'write');
      assertOccurrence(e, req.params.date);
      const wanted = req.body.status;
      const attendance = wanted === 'attended' || wanted === 'not_attended';
      const { row: member } = await loadMemberRow(db, actor, req.params.memberId, attendance ? 'read' : 'write', 'events');
      const { now } = await localNow(db, actor.organizationId);
      const start = shiftTo(e.starts_at, req.params.date).slice(0, 16);
      if (attendance && now < start) throw new Problem(409, 'not-started', 'Anwesenheit lässt sich erst ab Beginn des Termins eintragen.');
      if (!attendance) {
        if (!e.rsvp) throw new Problem(409, 'no-rsvp', 'Für diesen Termin gibt es keine Rückmeldungen.');
        if (now >= start) throw new Problem(409, 'closed', 'Der Termin hat schon begonnen; trag stattdessen die Anwesenheit ein.');
        if (e.registration_closes_hours !== null) {
          const closes = new Date(Date.parse(`${start}:00Z`) - e.registration_closes_hours * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
          if (now >= closes) throw new Problem(409, 'registration-closed', 'Die Anmeldefrist ist abgelaufen.');
        }
      }
      await db.transaction().execute(async (tx) => {
        // Serialise changes per occurrence so two last places cannot both be taken.
        await sql`select pg_advisory_xact_lock(hashtext(${`${e.id}|${req.params.date}`}))`.execute(tx);
        const current = await tx.selectFrom('participation').selectAll().where('event_id', '=', e.id).where('occurrence_date', '=', req.params.date).where('member_id', '=', member.id).executeTakeFirst();
        let status: ParticipationStatus = wanted;
        if (wanted === 'yes' && current?.status !== 'yes' && e.max_participants !== null) {
          const taken = await tx.selectFrom('participation').select(sql<number>`count(*)::int`.as('n')).where('event_id', '=', e.id).where('occurrence_date', '=', req.params.date).where('status', 'in', ['yes', 'attended']).executeTakeFirstOrThrow();
          if (taken.n >= e.max_participants) status = 'waitlist';
        }
        const values = { status, waitlisted_at: status === 'waitlist' ? (current?.waitlisted_at ?? new Date()) : null, updated_by: actor.userId, updated_at: new Date() };
        if (current) await tx.updateTable('participation').set(values).where('id', '=', current.id).execute();
        else await tx.insertInto('participation').values({ organization_id: actor.organizationId, event_id: e.id, occurrence_date: req.params.date, member_id: member.id, ...values }).execute();
        if (status === 'yes') await chargeOnce(tx, actor, e, req.params.date, member.id, member.person_id);
        await audit(tx, actor.organizationId, actor, { action: 'event.rsvp', entityType: 'event', entityId: e.id, diff: { member: [null, member.id], date: [null, req.params.date], status: [current?.status ?? null, status] } });
        // A freed place goes to the first person on the waitlist, but only before the event (no charging afterwards).
        if (!attendance && current?.status === 'yes' && status !== 'yes') {
          const next = await tx.selectFrom('participation').innerJoin('member', 'member.id', 'participation.member_id').select(['participation.id', 'participation.member_id', 'member.person_id']).where('participation.event_id', '=', e.id).where('participation.occurrence_date', '=', req.params.date).where('participation.status', '=', 'waitlist').orderBy('participation.waitlisted_at').limit(1).executeTakeFirst();
          if (next) {
            await tx.updateTable('participation').set({ status: 'yes', waitlisted_at: null, updated_at: new Date() }).where('id', '=', next.id).execute();
            await chargeOnce(tx, actor, e, req.params.date, next.member_id, next.person_id);
            await audit(tx, actor.organizationId, null, { action: 'event.waitlist_promoted', entityType: 'event', entityId: e.id, diff: { member: [null, next.member_id], date: [null, req.params.date] } });
          }
        }
      });
      return detail(actor, e.id, req.params.date);
    },
  );

  /** Paid events: the first confirmed place issues one invoice for this member and occurrence. */
  async function chargeOnce(tx: Db, actor: Actor, e: Ev, date: string, memberId: string, personId: string) {
    if (!e.price_cents) return;
    const p = await tx.selectFrom('participation').select(['id', 'invoice_id']).where('event_id', '=', e.id).where('occurrence_date', '=', date).where('member_id', '=', memberId).executeTakeFirstOrThrow();
    if (p.invoice_id) return;
    const today = await orgToday(tx, actor.organizationId);
    const invoiceId = await createDraft(tx, { organizationId: actor.organizationId, kind: 'other', personId, memberId, createdBy: actor.userId }, [{ text: `${e.title} am ${date.split('-').reverse().join('.')}`, quantity: 1, unitCents: e.price_cents, taxRate: 0 }]);
    await issueInvoice(tx, actor.organizationId, invoiceId, today);
    await tx.updateTable('participation').set({ invoice_id: invoiceId }).where('id', '=', p.id).execute();
  }

  // ---------- Birthdays ----------

  app.get('/birthdays', { schema: { tags, summary: 'Geburtstage im Zeitraum (nur mit Recht auf das Geburtsdatum)', querystring: z.object({ from: z.iso.date(), to: z.iso.date() }), response: { 200: z.array(birthday) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    if (restrictedFields(actor).has('birth_date')) return [];
    const { from, to } = req.query;
    if (dayDiff(from, to) > 400 || to < from) throw new Problem(400, 'range', 'Bitte höchstens ein gutes Jahr auf einmal abfragen.');
    const today = await orgToday(db, actor.organizationId);
    const rows = await db
      .selectFrom('member')
      .innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.birth_date'])
      .where('member.organization_id', '=', actor.organizationId)
      .where('member.status', 'in', ['active', 'future', 'resigned'])
      .where('person.birth_date', 'is not', null)
      .where(applyScope(actor, today, 'read'))
      .execute();
    const out: z.infer<typeof birthday>[] = [];
    for (const r of rows) {
      for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
        const md = r.birth_date!.slice(5) === '02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? '02-28' : r.birth_date!.slice(5);
        const date = `${y}-${md}`;
        if (date >= from && date <= to) out.push({ memberId: r.id, name: displayName({ kind: r.kind, firstName: r.first_name, lastName: r.last_name, companyName: r.company_name }), date, age: y - Number(r.birth_date!.slice(0, 4)) });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  });
};

/** Minimal iCalendar (RFC 5545) for subscriptions: wall-clock times with the club's TZID. */
export function ics(name: string, timeZone: string, events: Ev[]) {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const dt = (ts: string) => ts.replace(/[-:]/g, '').replace(' ', 'T').slice(0, 15);
  // Lines fold at 75 octets without splitting a UTF-8 character.
  const fold = (line: string) => {
    const parts: string[] = [];
    let cur = '';
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch) > (parts.length ? 74 : 75)) {
        parts.push(cur);
        cur = '';
      }
      cur += ch;
    }
    return [...parts, cur].join('\r\n ');
  };
  // shortcut: UNTIL ends at 23:59:59 UTC on the last day, so a late-night local event right after midnight could be included; exact conversion needs VTIMEZONE support.
  const rule = (r: string) => r.replace(/UNTIL=(\d{8})(?=;|$)/, 'UNTIL=$1T235959Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenVerein//DE', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${timeZone}`];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@openverein`, `DTSTAMP:${stamp}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${datePart(e.starts_at).replaceAll('-', '')}`, `DTEND;VALUE=DATE:${addDays(datePart(e.ends_at), 1).replaceAll('-', '')}`);
    } else {
      lines.push(`DTSTART;TZID=${timeZone}:${dt(e.starts_at)}`, `DTEND;TZID=${timeZone}:${dt(e.ends_at)}`);
    }
    if (e.rrule) lines.push(`RRULE:${e.all_day ? e.rrule : rule(e.rrule)}`);
    for (const x of e.exdates) lines.push(e.all_day ? `EXDATE;VALUE=DATE:${x.replaceAll('-', '')}` : `EXDATE;TZID=${timeZone}:${x.replaceAll('-', '')}T${dt(e.starts_at).slice(9)}`);
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
