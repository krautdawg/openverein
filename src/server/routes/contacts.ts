import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { loadMemberRow, orgToday } from '../members/query.ts';
import { restrictedFields, type Actor } from '../policy.ts';

const tags = ['members'];
const idParam = z.object({ id: z.uuid() });
export const CONTACT_KINDS = ['call', 'meeting', 'letter', 'email', 'other'] as const;
const entryInput = z.object({
  kind: z.enum(CONTACT_KINDS),
  occurredOn: z.iso.date(),
  text: z.string().trim().min(1, 'Pflichtfeld.').max(4000),
  fileId: z.uuid().nullish(),
  private: z.boolean().default(false),
});
const entry = z.object({ id: z.uuid(), kind: z.enum(CONTACT_KINDS), occurredOn: z.string(), text: z.string(), fileId: z.uuid().nullable(), fileName: z.string().nullable(), private: z.boolean(), author: z.string(), mine: z.boolean(), createdAt: z.string() });

/** Contact log per person (spec P06). Notes are as sensitive as the member note: same field restriction. */
export const contactRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function memberFor(actor: Actor, memberId: string, mode: 'read' | 'write', conn: Db = db) {
    if (restrictedFields(actor).has('note')) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Der Kontaktverlauf ist wie die Notiz geschützt.');
    return (await loadMemberRow(conn, actor, memberId, mode)).row;
  }

  async function list(actor: Actor, personId: string, id?: string) {
    let q = db.selectFrom('contact_log').innerJoin('app_user', 'app_user.id', 'contact_log.created_by').leftJoin('file', 'file.id', 'contact_log.file_id')
      .select(['contact_log.id', 'contact_log.kind', 'contact_log.occurred_on', 'contact_log.text', 'contact_log.file_id', 'file.name as file_name', 'contact_log.private', 'contact_log.created_by', 'contact_log.created_at', 'app_user.name as author'])
      .where('contact_log.organization_id', '=', actor.organizationId).where('contact_log.person_id', '=', personId)
      // Private entries only for their author.
      .where((eb) => eb.or([eb('contact_log.private', '=', false), eb('contact_log.created_by', '=', actor.userId ?? '00000000-0000-0000-0000-000000000000')]));
    if (id) q = q.where('contact_log.id', '=', id);
    const rows = await q.orderBy('contact_log.occurred_on', 'desc').orderBy('contact_log.created_at', 'desc').execute();
    return rows.map((r) => ({ id: r.id, kind: r.kind, occurredOn: r.occurred_on, text: r.text, fileId: r.file_id, fileName: r.file_name, private: r.private, author: r.author, mine: r.created_by === actor.userId, createdAt: r.created_at.toISOString() }));
  }

  app.get('/members/:id/contacts', { schema: { tags, summary: 'Kontaktverlauf (Anrufe, Treffen, Briefe); private Einträge nur für ihre Verfasser:in', params: idParam, response: { 200: z.array(entry) } } }, async (req) => {
    const actor = requireActor(req);
    const m = await memberFor(actor, req.params.id, 'read');
    return list(actor, m.person_id);
  });

  app.post('/members/:id/contacts', { schema: { tags, summary: 'Eintrag im Kontaktverlauf', params: idParam, body: entryInput, response: { 201: entry } } }, async (req, reply) => {
    const actor = requireActor(req);
    if (!actor.userId) throw new Problem(400, 'personal-account', 'Das geht nur mit einem persönlichen Zugang.');
    const m = await memberFor(actor, req.params.id, 'write');
    const b = req.body;
    if (b.occurredOn > (await orgToday(db, actor.organizationId))) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'occurredOn', message: 'Das Datum liegt in der Zukunft.' }] });
    // Only a file kept with this member can be attached.
    if (b.fileId && !(await db.selectFrom('file').select('id').where('id', '=', b.fileId).where('member_id', '=', m.id).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw notFound('Datei');
    const id = await db.transaction().execute(async (tx) => {
      const e = await tx.insertInto('contact_log').values({ organization_id: actor.organizationId, person_id: m.person_id, kind: b.kind, occurred_on: b.occurredOn, text: b.text, file_id: b.fileId ?? null, private: b.private, created_by: actor.userId! }).returning('id').executeTakeFirstOrThrow();
      // The audit keeps that a note was made, not its text.
      await audit(tx, actor.organizationId, actor, { action: 'contact.logged', entityType: 'member', entityId: m.id, diff: { kind: [null, b.kind], occurredOn: [null, b.occurredOn] } });
      return e.id;
    });
    reply.status(201);
    return (await list(actor, m.person_id, id))[0]!;
  });

  app.delete('/members/:id/contacts/:entryId', { schema: { tags, summary: 'Eigenen Eintrag im Kontaktverlauf löschen', params: z.object({ id: z.uuid(), entryId: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    const m = await memberFor(actor, req.params.id, 'write');
    await db.transaction().execute(async (tx) => {
      const r = await tx.deleteFrom('contact_log').where('id', '=', req.params.entryId).where('person_id', '=', m.person_id).where('created_by', '=', actor.userId ?? '').executeTakeFirst();
      if (!Number(r.numDeletedRows)) throw notFound('Eintrag');
      await audit(tx, actor.organizationId, actor, { action: 'contact.deleted', entityType: 'member', entityId: m.id });
    });
    return reply.status(204).send();
  });
};
