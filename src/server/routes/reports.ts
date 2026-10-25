import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { isHonouredAnniversary, isRoundBirthday, sameDay } from '../../shared/honours.ts';
import { sql } from 'kysely';
import { z } from 'zod';
import { requireActor } from '../auth/session.ts';
import { csvCell } from './members.ts';
import { displayName } from '../../shared/members.ts';
import { applyScope, loadMemberRow, orgToday } from '../members/query.ts';
import { audit } from '../audit.ts';
import { notFound } from '../http/problem.ts';
import { requireClubWide, requirePermission, restrictedFields, type Actor } from '../policy.ts';

/** Age brackets of the DOSB/LSB census; the age is the year of the census minus the year of birth. */
export const CENSUS_BRACKETS = [
  { label: 'bis 6', from: 0, to: 6 },
  { label: '7–14', from: 7, to: 14 },
  { label: '15–18', from: 15, to: 18 },
  { label: '19–26', from: 19, to: 26 },
  { label: '27–40', from: 27, to: 40 },
  { label: '41–60', from: 41, to: 60 },
  { label: 'über 60', from: 61, to: 200 },
] as const;
const GENDERS = ['female', 'male', 'diverse', 'unknown'] as const;
const counts = z.record(z.string(), z.record(z.enum(GENDERS), z.number()));
const row = z.object({ groupId: z.uuid().nullable(), name: z.string(), counts, noBirthDate: z.number(), total: z.number() });

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function census(actor: Actor, year: number) {
    // Club-wide figures: a division lead would see a partial total and report it as the club's.
    requireClubWide(actor, 'members', 'read');
    const date = `${year}-01-01`;
    // Members on the census date (by join and exit date, not today's status); one row per member and division.
    const members = await sql<{ id: string; gender: string | null; birth_year: number | null; group_id: string | null; group_name: string | null }>`
      select m.id, p.gender, extract(year from p.birth_date)::int as birth_year, g.id as group_id, g.name as group_name
      from member m
      join person p on p.id = m.person_id
      left join group_membership gm on gm.member_id = m.id and gm.valid_from <= ${date}::date and (gm.valid_to is null or gm.valid_to >= ${date}::date)
      left join club_group g on g.id = gm.group_id and g.kind = 'division'
      where m.organization_id = ${actor.organizationId} and p.kind = 'natural'
        and m.join_date <= ${date}::date and (m.exit_date is null or m.exit_date >= ${date}::date)`.execute(db);
    const tally = (rows: typeof members.rows) => {
      const c = Object.fromEntries(CENSUS_BRACKETS.map((b) => [b.label, Object.fromEntries(GENDERS.map((g) => [g, 0]))])) as Record<string, Record<(typeof GENDERS)[number], number>>;
      let noBirthDate = 0;
      for (const r of rows) {
        if (r.birth_year === null) { noBirthDate++; continue; }
        const age = year - r.birth_year;
        const b = CENSUS_BRACKETS.find((x) => age >= x.from && age <= x.to) ?? CENSUS_BRACKETS[0];
        c[b.label]![(r.gender ?? 'unknown') as (typeof GENDERS)[number]]++;
      }
      return { counts: c, noBirthDate, total: rows.length };
    };
    const once = [...new Map(members.rows.map((r) => [r.id, r])).values()];
    const divisions = new Map<string, { name: string; rows: typeof members.rows }>();
    for (const r of members.rows) {
      if (!r.group_id) continue;
      const d = divisions.get(r.group_id) ?? { name: r.group_name!, rows: [] };
      if (!d.rows.some((x) => x.id === r.id)) d.rows.push(r);
      divisions.set(r.group_id, d);
    }
    const rows = [
      { groupId: null, name: 'Verein gesamt', ...tally(once) },
      ...[...divisions.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'de')).map(([id, d]) => ({ groupId: id, name: d.name, ...tally(d.rows) })),
    ];
    return { year, date, brackets: CENSUS_BRACKETS.map((b) => b.label), rows };
  }

  const query = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
  app.get('/reports/census', {
    schema: {
      tags: ['members'],
      summary: 'Bestandserhebung für Landessportbund/DOSB: Mitglieder am 1. Januar nach Altersgruppe und Geschlecht, gesamt und je Abteilung',
      querystring: query,
      response: { 200: z.object({ year: z.number(), date: z.string(), brackets: z.array(z.string()), rows: z.array(row) }) },
    },
  }, async (req) => census(requireActor(req), req.query.year));

  app.get('/reports/census.csv', { schema: { tags: ['members'], summary: 'Bestandserhebung als CSV (Semikolon, UTF-8)', querystring: query } }, async (req, reply) => {
    const { year, rows } = await census(requireActor(req), req.query.year);
    const head = ['Bereich', ...CENSUS_BRACKETS.flatMap((b) => [`${b.label} w`, `${b.label} m`, `${b.label} d`, `${b.label} ohne Angabe`]), 'ohne Geburtsdatum', 'gesamt'];
    const lines = rows.map((r) => [r.name, ...CENSUS_BRACKETS.flatMap((b) => GENDERS.map((g) => r.counts[b.label]![g])), r.noBirthDate, r.total].map(csvCell).join(';'));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="Bestandserhebung-${year}.csv"`).send('﻿' + [head.map(csvCell).join(';'), ...lines].join('\r\n') + '\r\n');
  });

  const honour = z.object({ memberId: z.uuid(), name: z.string(), date: z.string(), years: z.number() });
  const awarded = z.object({ id: z.uuid(), memberId: z.uuid(), name: z.string(), title: z.string(), awardedOn: z.string(), decision: z.string().nullable() });
  app.get('/reports/honours', {
    schema: {
      tags: ['members'],
      summary: 'Ehrungen eines Jahres: Vereinsjubiläen (ab 10 Jahre, alle 5 Jahre) und runde Geburtstage der aktuellen Mitglieder',
      querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
      response: { 200: z.object({ anniversaries: z.array(honour), birthdays: z.array(honour).nullable(), awarded: z.array(awarded) }) },
    },
  }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const today = await orgToday(db, actor.organizationId);
    const { year } = req.query;
    const base = db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id', 'member.join_date', 'person.birth_date', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('member.organization_id', '=', actor.organizationId)
      .where('member.status', 'in', ['active', 'future', 'resigned'])
      .where(applyScope(actor, today, 'read'));
    const rows = await base.execute();
    const nameOf = (r: (typeof rows)[number]) => displayName({ kind: r.kind, firstName: r.first_name, lastName: r.last_name, companyName: r.company_name });
    const anniversaries = rows
      .filter((r) => r.join_date)
      .map((r) => ({ r, years: year - Number(r.join_date!.slice(0, 4)) }))
      .filter(({ years }) => isHonouredAnniversary(years))
      .map(({ r, years }) => ({ memberId: r.id, name: nameOf(r), date: sameDay(r.join_date!, year), years }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'de'));
    const birthdays = restrictedFields(actor).has('birth_date')
      ? null
      : rows
          .filter((r) => r.birth_date && r.kind === 'natural')
          .map((r) => ({ memberId: r.id, name: nameOf(r), date: sameDay(r.birth_date!, year), years: year - Number(r.birth_date!.slice(0, 4)) }))
          .filter((h) => isRoundBirthday(h.years))
          .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'de'));
    // Honours awarded in that year, for the members this user may see.
    const visible = new Map(rows.map((r) => [r.id, nameOf(r)]));
    const given = await db.selectFrom('honour').selectAll().where('organization_id', '=', actor.organizationId).where('awarded_on', '>=', `${year}-01-01`).where('awarded_on', '<=', `${year}-12-31`).orderBy('awarded_on').execute();
    const awardedList = given.filter((h) => visible.has(h.member_id)).map((h) => ({ id: h.id, memberId: h.member_id, name: visible.get(h.member_id)!, title: h.title, awardedOn: h.awarded_on, decision: h.decision }));
    return { anniversaries, birthdays, awarded: awardedList };
  });

  app.post('/members/:id/honours', { schema: { tags: ['members'], summary: 'Verliehene Ehrung eintragen (z. B. Ehrennadel), mit Datum und Beschluss', params: z.object({ id: z.uuid() }), body: z.object({ title: z.string().trim().min(1, 'Pflichtfeld.').max(200), awardedOn: z.iso.date(), decision: z.string().trim().max(500).nullish() }), response: { 201: awarded } } }, async (req, reply) => {
    const actor = requireActor(req);
    const { row } = await loadMemberRow(db, actor, req.params.id, 'write');
    const h = await db.transaction().execute(async (tx) => {
      const h = await tx.insertInto('honour').values({ organization_id: actor.organizationId, member_id: row.id, title: req.body.title, awarded_on: req.body.awardedOn, decision: req.body.decision ?? null, created_by: actor.userId }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'member.honoured', entityType: 'member', entityId: row.id, diff: { honour: [null, `${h.title} (${h.awarded_on})`] } });
      return h;
    });
    reply.status(201);
    return { id: h.id, memberId: row.id, name: displayName({ kind: row.kind, firstName: row.first_name, lastName: row.last_name, companyName: row.company_name }), title: h.title, awardedOn: h.awarded_on, decision: h.decision };
  });

  app.delete('/members/:id/honours/:honourId', { schema: { tags: ['members'], summary: 'Eingetragene Ehrung entfernen (Tippfehler)', params: z.object({ id: z.uuid(), honourId: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    const { row } = await loadMemberRow(db, actor, req.params.id, 'write');
    await db.transaction().execute(async (tx) => {
      const h = await tx.deleteFrom('honour').where('id', '=', req.params.honourId).where('member_id', '=', row.id).returningAll().executeTakeFirst();
      if (!h) throw notFound('Ehrung');
      await audit(tx, actor.organizationId, actor, { action: 'member.honour_removed', entityType: 'member', entityId: row.id, diff: { honour: [`${h.title} (${h.awarded_on})`, null] } });
    });
    return reply.status(204).send();
  });
};
