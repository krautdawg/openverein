import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide } from '../policy.ts';

const tags = ['communication'];
const pollInput = z.object({
  question: z.string().trim().min(1, 'Wie lautet die Frage?').max(300),
  description: z.string().trim().max(2000).nullish(),
  options: z.array(z.string().trim().min(1).max(200)).min(2, 'Mindestens zwei Antworten.').max(20),
  multiple: z.boolean().default(false),
  groupId: z.uuid().nullish(),
  closesOn: z.iso.date(),
});
export const pollResult = z.object({ id: z.uuid(), question: z.string(), description: z.string().nullable(), options: z.array(z.string()), multiple: z.boolean(), groupId: z.uuid().nullable(), closesOn: z.string(), open: z.boolean(), eligible: z.number(), answered: z.number(), counts: z.array(z.number()) });

/** Members who may answer: members on the day (by join and exit date), and in the poll's group if it has one. */
export function eligibleMembers(db: Db, organizationId: string, groupId: string | null, today: string) {
  let q = db.selectFrom('member').where('member.organization_id', '=', organizationId).where('member.join_date', '<=', today).where((eb) => eb.or([eb('member.exit_date', 'is', null), eb('member.exit_date', '>=', today)]));
  if (groupId) q = q.where(sql<boolean>`exists (select 1 from group_membership gm where gm.member_id = member.id and gm.group_id = ${groupId} and gm.valid_from <= ${today}::date and (gm.valid_to is null or gm.valid_to >= ${today}::date))`);
  return q;
}

export async function pollResults(db: Db, organizationId: string, id?: string) {
  const today = await orgToday(db, organizationId);
  let q = db.selectFrom('poll').selectAll().where('organization_id', '=', organizationId);
  if (id) q = q.where('id', '=', id);
  const polls = await q.orderBy('closes_on', 'desc').execute();
  const out: z.infer<typeof pollResult>[] = [];
  for (const p of polls) {
    const votes = await db.selectFrom('poll_vote').select('choices').where('poll_id', '=', p.id).execute();
    const counts = p.options.map((_, i) => votes.filter((v) => v.choices.includes(i)).length);
    // The electorate of a finished poll is fixed at its last day (later group changes do not move it), and everyone
    // who answered counts, so participation never exceeds 100 %.
    const day = p.closes_on < today ? p.closes_on : today;
    const electorate = eligibleMembers(db, organizationId, p.group_id, day).select('member.id').union(db.selectFrom('poll_vote').select('member_id as id').where('poll_id', '=', p.id));
    const eligible = (await db.selectFrom(electorate.as('e')).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n;
    out.push({ id: p.id, question: p.question, description: p.description, options: p.options, multiple: p.multiple, groupId: p.group_id, closesOn: p.closes_on, open: p.closes_on >= today, eligible, answered: votes.length, counts });
  }
  return out;
}

export const pollRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/polls', { schema: { tags, summary: 'Umfragen mit Ergebnis', response: { 200: z.array(pollResult) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'communication', 'read');
    return pollResults(db, actor.organizationId);
  });

  app.post('/polls', { schema: { tags, summary: 'Umfrage starten: aktuelle Mitglieder (oder eine Gruppe) antworten im Mitgliederportal, eine Antwort je Mitgliedschaft', body: pollInput, response: { 201: pollResult } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'communication', 'write');
    const b = req.body;
    const today = await orgToday(db, actor.organizationId);
    if (b.closesOn < today) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'closesOn', message: 'Das Ende liegt in der Vergangenheit.' }] });
    if (b.groupId && !(await db.selectFrom('club_group').select('id').where('id', '=', b.groupId).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw notFound('Gruppe');
    const id = await db.transaction().execute(async (tx) => {
      const p = await tx.insertInto('poll').values({ organization_id: actor.organizationId, question: b.question, description: b.description ?? null, options: b.options, multiple: b.multiple, group_id: b.groupId ?? null, closes_on: b.closesOn, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'poll.created', entityType: 'poll', entityId: p.id, diff: { question: [null, b.question] } });
      return p.id;
    });
    reply.status(201);
    return (await pollResults(db, actor.organizationId, id))[0]!;
  });

  app.post('/polls/:id/close', { schema: { tags, summary: 'Umfrage vorzeitig beenden', params: z.object({ id: z.uuid() }), body: z.object({}).optional(), response: { 200: pollResult } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'communication', 'write');
    const today = await orgToday(db, actor.organizationId);
    await db.transaction().execute(async (tx) => {
      // Ends yesterday, so today counts as closed.
      const r = await tx.updateTable('poll').set({ closes_on: sql<string>`least(closes_on, ${today}::date - 1)` }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('Umfrage');
      await audit(tx, actor.organizationId, actor, { action: 'poll.closed', entityType: 'poll', entityId: req.params.id });
    });
    return (await pollResults(db, actor.organizationId, req.params.id))[0]!;
  });
};
