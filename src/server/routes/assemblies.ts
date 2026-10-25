import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import { z } from 'zod';
import { assembly, assemblyInput } from '../../shared/assemblies.ts';
import { addDays, formatDate } from '../../shared/dates.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { FONT, FONT_BOLD } from '../invoices/pdf.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide, type Actor } from '../policy.ts';
import { createMessage, resolveRecipients } from './messages.ts';

const tags = ['members'];
const idParam = z.object({ id: z.uuid() });

export const assemblyRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function load(organizationId: string, id: string) {
    const a = await db.selectFrom('assembly').selectAll().where('id', '=', id).where('organization_id', '=', organizationId).executeTakeFirst();
    if (!a) throw notFound('Versammlung');
    return a;
  }

  async function detail(organizationId: string, id: string): Promise<z.infer<typeof assembly>> {
    const a = await load(organizationId, id);
    const items = await db.selectFrom('assembly_item').selectAll().where('assembly_id', '=', id).orderBy('position').execute();
    const attendees = (await db.selectFrom('assembly_attendance').select('member_id').where('assembly_id', '=', id).execute()).map((r) => r.member_id);
    let eq = db.selectFrom('member').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', organizationId).where('join_date', '<=', a.held_on).where((eb) => eb.or([eb('exit_date', 'is', null), eb('exit_date', '>=', a.held_on)]));
    if (a.group_id) eq = eq.where(sql<boolean>`exists (select 1 from group_membership gm where gm.member_id = member.id and gm.group_id = ${a.group_id} and gm.valid_from <= ${a.held_on}::date and (gm.valid_to is null or gm.valid_to >= ${a.held_on}::date))`);
    const eligible = await eq.executeTakeFirstOrThrow();
    return {
      id: a.id, kind: a.kind, groupId: a.group_id, title: a.title, heldOn: a.held_on, startsAt: a.starts_at, place: a.place, noticeDays: a.notice_days, inviteBy: addDays(a.held_on, -a.notice_days),
      chair: a.chair, minutesBy: a.minutes_by, invitedAt: a.invited_at?.toISOString() ?? null, messageId: a.message_id, closedAt: a.closed_at?.toISOString() ?? null,
      items: items.map((i) => ({ id: i.id, position: i.position, title: i.title, description: i.description, isVote: i.is_vote, votesYes: i.votes_yes, votesNo: i.votes_no, votesAbstain: i.votes_abstain, outcome: i.outcome })),
      attendees, eligible: eligible.n,
    };
  }

  const writeItems = async (tx: Db, id: string, items: z.infer<typeof assemblyInput>['items']) => {
    await tx.deleteFrom('assembly_item').where('assembly_id', '=', id).execute();
    await tx.insertInto('assembly_item').values(items.map((it, i) => ({ assembly_id: id, position: i + 1, title: it.title, description: it.description ?? null, is_vote: it.isVote }))).execute();
  };
  /** A board meeting needs its group, from this club. */
  async function checkGroup(actor: Actor, b: z.infer<typeof assemblyInput>) {
    if (b.kind !== 'board') return;
    if (!b.groupId) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'groupId', message: 'Wer wird eingeladen?' }] });
    if (!(await db.selectFrom('club_group').select('id').where('id', '=', b.groupId).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw notFound('Gruppe');
  }

  /** The board runs assemblies: club-wide member write access. */
  const board = (actor: Actor) => requireClubWide(actor, 'members', 'write');

  app.get('/assemblies', { schema: { tags, summary: 'Mitgliederversammlungen', response: { 200: z.array(z.object({ id: z.uuid(), title: z.string(), heldOn: z.string(), invitedAt: z.string().nullable(), closedAt: z.string().nullable() })) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const rows = await db.selectFrom('assembly').select(['id', 'title', 'held_on', 'invited_at', 'closed_at']).where('organization_id', '=', actor.organizationId).orderBy('held_on', 'desc').execute();
    return rows.map((r) => ({ id: r.id, title: r.title, heldOn: r.held_on, invitedAt: r.invited_at?.toISOString() ?? null, closedAt: r.closed_at?.toISOString() ?? null }));
  });

  app.get('/assemblies/:id', { schema: { tags, summary: 'Eine Versammlung mit Tagesordnung, Anwesenheit und Ergebnissen', params: idParam, response: { 200: assembly } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    return detail(actor.organizationId, req.params.id);
  });

  app.post('/assemblies', { schema: { tags, summary: 'Versammlung mit Tagesordnung anlegen', body: assemblyInput, response: { 201: assembly } } }, async (req, reply) => {
    const actor = requireActor(req);
    board(actor);
    const b = req.body;
    await checkGroup(actor, b);
    const id = await db.transaction().execute(async (tx) => {
      const a = await tx.insertInto('assembly').values({ organization_id: actor.organizationId, kind: b.kind, group_id: b.kind === 'board' ? b.groupId! : null, title: b.title, held_on: b.heldOn, starts_at: b.startsAt, place: b.place, notice_days: b.noticeDays }).returning('id').executeTakeFirstOrThrow();
      await writeItems(tx, a.id, b.items);
      await audit(tx, actor.organizationId, actor, { action: 'assembly.created', entityType: 'assembly', entityId: a.id, diff: { title: [null, b.title], heldOn: [null, b.heldOn] } });
      return a.id;
    });
    reply.status(201);
    return detail(actor.organizationId, id);
  });

  app.put('/assemblies/:id', { schema: { tags, summary: 'Versammlung und Tagesordnung ändern (nur vor der Einladung)', params: idParam, body: assemblyInput, response: { 200: assembly } } }, async (req) => {
    const actor = requireActor(req);
    board(actor);
    const a = await load(actor.organizationId, req.params.id);
    // Members were invited with this agenda; a changed one needs a new assembly or a supplementary invitation.
    if (a.invited_at) throw new Problem(409, 'invited', 'Die Einladung ist schon verschickt.', 'Tagesordnung und Termin stehen fest.');
    const b = req.body;
    await checkGroup(actor, b);
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('assembly').set({ kind: b.kind, group_id: b.kind === 'board' ? b.groupId! : null, title: b.title, held_on: b.heldOn, starts_at: b.startsAt, place: b.place, notice_days: b.noticeDays }).where('id', '=', a.id).execute();
      await writeItems(tx, a.id, b.items);
      await audit(tx, actor.organizationId, actor, { action: 'assembly.updated', entityType: 'assembly', entityId: a.id, diff: { title: [a.title, b.title], heldOn: [a.held_on, b.heldOn] } });
    });
    return detail(actor.organizationId, a.id);
  });

  app.post('/assemblies/:id/invite', { schema: { tags, summary: 'Einladung mit Tagesordnung per E-Mail an alle aktuellen Mitglieder, bei Vorstandssitzungen an die Gruppe (prüft die Einladungsfrist); wer keine E-Mail hat, wird für den Brief gelistet', params: idParam, body: z.object({}).optional(), response: { 200: z.object({ sent: z.number(), letters: z.array(z.object({ memberId: z.uuid(), name: z.string(), reason: z.string() })) }) } } }, async (req) => {
    const actor = requireActor(req);
    board(actor);
    requireClubWide(actor, 'communication', 'write');
    const a = await detail(actor.organizationId, req.params.id);
    if (a.invitedAt) throw new Problem(409, 'invited', 'Die Einladung ist schon verschickt.');
    const today = await orgToday(db, actor.organizationId);
    if (today > a.inviteBy) throw new Problem(409, 'notice-period', `Die Einladungsfrist von ${a.noticeDays} Tagen ist nicht mehr einzuhalten.`, `Spätestens am ${formatDate(a.inviteBy)} hätte die Einladung rausgehen müssen. Verschiebe die Versammlung.`);
    const org = await db.selectFrom('organization').select('name').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const subject = `Einladung: ${a.title} am ${formatDate(a.heldOn)}`;
    const body = [
      'Hallo {{vorname}},',
      '',
      `wir laden Dich herzlich ein zur ${a.title}`,
      `am ${formatDate(a.heldOn)} um ${a.startsAt} Uhr`,
      `Ort: ${a.place}`,
      '',
      'Tagesordnung:',
      ...a.items.map((i) => `${i.position}. ${i.title}${i.description ? `\n   ${i.description.replace(/\n/g, '\n   ')}` : ''}`),
      '',
      'Viele Grüße',
      org.name,
    ].join('\n');
    const { recipients, excluded } = await resolveRecipients(db, actor, a.groupId ? { mode: 'group', groupId: a.groupId } : { mode: 'all' }, 'notice');
    // Former members are not invited at all; everyone else without e-mail gets a letter.
    const letters = excluded.filter((e) => e.reason !== 'kein aktuelles Mitglied');
    await db.transaction().execute(async (tx) => {
      const messageId = recipients.length ? await createMessage(tx, actor, { kind: 'free', category: 'notice', subject, body, filter: { mode: a.groupId ? 'group' : 'all', groupId: a.groupId, assemblyId: a.id } }, recipients.map((r) => ({ personId: r.personId, memberId: r.memberId, email: r.email }))) : null;
      await tx.updateTable('assembly').set({ invited_at: new Date(), message_id: messageId }).where('id', '=', a.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'assembly.invited', entityType: 'assembly', entityId: a.id, diff: { emails: [null, recipients.length], letters: [null, letters.length] } });
    });
    return { sent: recipients.length, letters };
  });

  app.put('/assemblies/:id/attendance', { schema: { tags, summary: 'Anwesende Mitglieder festhalten (ersetzt die Liste)', params: idParam, body: z.object({ memberIds: z.array(z.uuid()).max(10_000) }), response: { 200: assembly } } }, async (req) => {
    const actor = requireActor(req);
    board(actor);
    const a = await load(actor.organizationId, req.params.id);
    const ids = [...new Set(req.body.memberIds)];
    const known = ids.length ? await db.selectFrom('member').select('id').where('organization_id', '=', actor.organizationId).where('id', 'in', ids).execute() : [];
    if (known.length !== ids.length) throw new Problem(400, 'validation', 'Unbekannte Mitglieder in der Liste.');
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('assembly_attendance').where('assembly_id', '=', a.id).execute();
      if (ids.length) await tx.insertInto('assembly_attendance').values(ids.map((m) => ({ assembly_id: a.id, member_id: m }))).execute();
      await audit(tx, actor.organizationId, actor, { action: 'assembly.attendance', entityType: 'assembly', entityId: a.id, diff: { present: [null, ids.length] } });
    });
    return detail(actor.organizationId, a.id);
  });

  app.put('/assemblies/:id/items/:itemId', { schema: { tags, summary: 'Ergebnis eines Tagesordnungspunktes festhalten (Stimmen und Beschluss)', params: idParam.extend({ itemId: z.uuid() }), body: z.object({ votesYes: z.number().int().min(0).nullable(), votesNo: z.number().int().min(0).nullable(), votesAbstain: z.number().int().min(0).nullable(), outcome: z.string().trim().max(2000).nullable() }), response: { 200: assembly } } }, async (req) => {
    const actor = requireActor(req);
    board(actor);
    const a = await load(actor.organizationId, req.params.id);
    const b = req.body;
    await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('assembly_item').set({ votes_yes: b.votesYes, votes_no: b.votesNo, votes_abstain: b.votesAbstain, outcome: b.outcome || null }).where('id', '=', req.params.itemId).where('assembly_id', '=', a.id).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('Tagesordnungspunkt');
      await audit(tx, actor.organizationId, actor, { action: 'assembly.result', entityType: 'assembly', entityId: a.id, diff: { item: [null, req.params.itemId], votes: [null, [b.votesYes, b.votesNo, b.votesAbstain]] } });
    });
    return detail(actor.organizationId, a.id);
  });

  app.post('/assemblies/:id/close', { schema: { tags, summary: 'Versammlung abschließen: Versammlungsleitung und Protokoll; danach unveränderlich', params: idParam, body: z.object({ chair: z.string().trim().min(1, 'Wer hat geleitet?').max(120), minutesBy: z.string().trim().min(1, 'Wer hat protokolliert?').max(120) }), response: { 200: assembly } } }, async (req) => {
    const actor = requireActor(req);
    board(actor);
    const a = await load(actor.organizationId, req.params.id);
    if (a.closed_at) throw new Problem(409, 'closed', 'Die Versammlung ist schon abgeschlossen.');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('assembly').set({ chair: req.body.chair, minutes_by: req.body.minutesBy, closed_at: new Date() }).where('id', '=', a.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'assembly.closed', entityType: 'assembly', entityId: a.id });
    });
    return detail(actor.organizationId, a.id);
  });

  app.get('/assemblies/:id/minutes.pdf', { schema: { tags, summary: 'Protokoll als PDF (Entwurf, solange die Versammlung nicht abgeschlossen ist)', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const a = await detail(actor.organizationId, req.params.id);
    const org = await db.selectFrom('organization').select('name').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const pdf = await minutesPdf(a, org.name);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="Protokoll-${a.heldOn}.pdf"`).header('cache-control', 'private, no-store').send(pdf);
  });
};

const mm = (v: number) => (v * 72) / 25.4;

/** Minutes: who, when, where, attendance against members on the day, each agenda item with its result, signatures. */
function minutesPdf(a: z.infer<typeof assembly>, club: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: mm(20), left: mm(25), right: mm(20), bottom: mm(20) }, info: { Title: `Protokoll ${a.title}`, Author: club } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const ink = '#14202e';
  const muted = '#5f6874';
  const width = doc.page.width - mm(45);
  if (!a.closedAt) doc.font('bold').fontSize(9).fillColor('#b42318').text('ENTWURF: Die Versammlung ist noch nicht abgeschlossen.', { width });
  doc.font('text').fontSize(9).fillColor(muted).text(club, { width });
  doc.moveDown(0.3).font('bold').fontSize(16).fillColor(ink).text(`Protokoll: ${a.title}`, { width });
  doc.moveDown(0.4).font('text').fontSize(10).fillColor(ink).text(`${formatDate(a.heldOn)}, ${a.startsAt} Uhr, ${a.place}`, { width });
  doc.text(`Versammlungsleitung: ${a.chair ?? '…'} · Protokoll: ${a.minutesBy ?? '…'}`, { width });
  doc.text(`Anwesend: ${a.attendees.length} von ${a.eligible} Mitgliedern. Eingeladen: ${a.invitedAt ? formatDate(a.invitedAt.slice(0, 10)) : 'nicht über OpenVerein'}.`, { width });
  doc.moveDown(1);
  for (const i of a.items) {
    doc.font('bold').fontSize(11).fillColor(ink).text(`${i.position}. ${i.title}`, { width });
    if (i.description) doc.font('text').fontSize(9.5).fillColor(muted).text(i.description, { width });
    if (i.isVote) {
      const counted = i.votesYes !== null || i.votesNo !== null || i.votesAbstain !== null;
      doc.font('text').fontSize(10).fillColor(ink).text(counted ? `Abstimmung: ${i.votesYes ?? 0} Ja, ${i.votesNo ?? 0} Nein, ${i.votesAbstain ?? 0} Enthaltungen.` : 'Abstimmung: kein Ergebnis eingetragen.', { width });
    }
    if (i.outcome) doc.font('text').fontSize(10).fillColor(ink).text(i.outcome, { width });
    doc.moveDown(0.8);
  }
  doc.moveDown(2);
  const y = doc.y + 20;
  const half = width / 2 - mm(5);
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + half, y).lineWidth(0.5).strokeColor(ink).stroke();
  doc.moveTo(doc.page.margins.left + half + mm(10), y).lineTo(doc.page.margins.left + width, y).stroke();
  doc.font('text').fontSize(8).fillColor(muted).text('Versammlungsleitung', doc.page.margins.left, y + 4, { width: half });
  doc.text('Protokoll', doc.page.margins.left + half + mm(10), y + 4, { width: half });
  doc.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
