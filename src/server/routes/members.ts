import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { proposeExitDate } from '../../shared/dates.ts';
import {
  bulkBody,
  displayName,
  bulkResult,
  date,
  memberCreate,
  memberDetail as memberDetailSchema,
  memberList,
  memberListQuery,
  memberPatch,
  postalCodeProblem,
  resignBody,
  STATUS_LABEL,
  type MemberStatus,
} from '../../shared/members.ts';
import { audit, diffOf } from '../audit.ts';
import { assertGroup, BULK_INLINE_MAX, memberBulk } from '../members/bulk.ts';
import { jobDto, jobSchema } from './jobs.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { forbidden, Problem } from '../http/problem.ts';
import { nextNumber } from '../members/numbers.ts';
import { applyScope, currentGroups, loadMemberRow, memberColumns, memberDetail, orgToday, toListItem } from '../members/query.ts';
import { statusForJoin } from '../members/status.ts';
import { fieldsFor, seesSensitive, writeCustom } from '../members/custom.ts';
import { assertIfMatch, setETag, versionOf } from '../http/concurrency.ts';
import { customText } from '../../shared/customFields.ts';
import { can, requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';

const idParam = z.object({ id: z.uuid() });
const tags = ['members'];

/** camelCase person fields from the API to snake_case columns. */
const PERSON_COLUMNS = {
  kind: 'kind',
  firstName: 'first_name',
  lastName: 'last_name',
  companyName: 'company_name',
  birthDate: 'birth_date',
  email: 'email',
  phone: 'phone',
  street: 'street',
  postalCode: 'postal_code',
  city: 'city',
  country: 'country',
  preferredChannel: 'preferred_channel',
  note: 'note',
  einvoiceFormat: 'einvoice_format',
  buyerReference: 'buyer_reference',
  einvoiceAddress: 'einvoice_address',
  vatId: 'vat_id',
} as const;

function personValues(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [api, col] of Object.entries(PERSON_COLUMNS)) if (body[api] !== undefined) out[col] = body[api];
  return out;
}

/** A user may not write a field their roles hide from them. */
function assertWritable(actor: Actor, body: Record<string, unknown>) {
  const hidden = restrictedFields(actor);
  for (const [api, col] of Object.entries(PERSON_COLUMNS)) {
    if (body[api] !== undefined && hidden.has(col)) throw forbidden(`members.field.${col}`);
  }
}

const listFilter = (q: z.infer<typeof memberListQuery>, actor: Actor, today: string) => (db: Db) => {
  let query = db
    .selectFrom('member')
    .innerJoin('person', 'person.id', 'member.person_id')
    .where('member.organization_id', '=', actor.organizationId)
    .where(applyScope(actor, today, 'read'));
  const statuses = q.status ? ([] as MemberStatus[]).concat(q.status) : null;
  if (statuses) query = query.where('member.status', 'in', statuses);
  // An exit range is about former members: it includes them.
  else if (!q.includeFormer && !q.exitFrom && !q.exitTo) query = query.where('member.status', 'not in', ['former', 'rejected']);
  if (q.groupId) {
    query = query.where(
      sql<boolean>`exists (select 1 from group_membership gm where gm.member_id = member.id and gm.group_id = ${q.groupId}
        and gm.valid_from <= ${today}::date and (gm.valid_to is null or gm.valid_to >= ${today}::date))`,
    );
  }
  // Facets reveal what they filter on: each needs the right to see that data (403, never a silently wider list).
  if ((q.ageFrom !== undefined || q.ageTo !== undefined) && restrictedFields(actor).has('birth_date')) throw forbidden('members.field.birth_date');
  if (q.mandate && !can(actor, 'sepa', 'read')) throw forbidden('sepa:read');
  if (q.openBalance && !can(actor, 'invoices', 'read')) throw forbidden('invoices:read');
  if (q.paymentMethod && !can(actor, 'fees', 'read')) throw forbidden('fees:read');
  // Facets combine with AND; ages are completed years on today's date (members without birth date drop out).
  if (q.paymentMethod) query = query.where('member.payment_method', '=', q.paymentMethod);
  if (q.ageFrom !== undefined) query = query.where(sql<boolean>`person.birth_date <= (${today}::date - make_interval(years => ${q.ageFrom}))`);
  if (q.ageTo !== undefined) query = query.where(sql<boolean>`person.birth_date > (${today}::date - make_interval(years => ${q.ageTo + 1}))`);
  if (q.joinFrom) query = query.where('member.join_date', '>=', q.joinFrom);
  if (q.joinTo) query = query.where('member.join_date', '<=', q.joinTo);
  if (q.exitFrom) query = query.where('member.exit_date', '>=', q.exitFrom);
  if (q.exitTo) query = query.where('member.exit_date', '<=', q.exitTo);
  if (q.mandate) {
    const has = sql<boolean>`exists (select 1 from sepa_mandate s where s.person_id = person.id and s.status = 'active')`;
    query = query.where(q.mandate === 'active' ? has : sql<boolean>`not ${has}`);
  }
  if (q.household) query = query.where('member.household_id', q.household === 'yes' ? 'is not' : 'is', null);
  if (q.openBalance) query = query.where(sql<boolean>`exists (select 1 from invoice i where (i.member_id = member.id or i.recipient_person_id = person.id) and i.status in ('open', 'partially_paid') and i.kind in ('membership', 'other', 'dunning_fee'))`);
  if (q.cf) {
    const [id, value] = [q.cf.slice(0, 36), q.cf.slice(37)];
    const like = `%${value.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    // Text fields match partly, the others exactly (checkbox: "true"/"false"; multiselect: one of the values).
    query = query.where(sql<boolean>`exists (select 1 from custom_field f where f.id = ${id}::uuid and f.organization_id = member.organization_id and f.archived_at is null and (f.sensitive = false or ${seesSensitive(actor)})
      and case f.type
        when 'text' then person.custom ->> f.id::text ilike ${like}
        when 'multiline' then person.custom ->> f.id::text ilike ${like}
        when 'multiselect' then person.custom -> f.id::text ? ${value}
        else person.custom ->> f.id::text = ${value} end)`);
  }
  if (q.q) {
    const term = q.q.toLowerCase();
    const escaped = term.replace(/[%_\\]/g, (c) => '\\' + c);
    const like = `%${escaped}%`;
    const plain = sql<string>`lower(unaccent(${term}))`;
    const plainLike = sql<string>`'%' || lower(unaccent(${escaped})) || '%'`;
    const name = sql<string>`lower(unaccent(coalesce(person.last_name, '') || ' ' || coalesce(person.first_name, '') || ' ' || coalesce(person.company_name, '')))`;
    const nameRev = sql<string>`lower(unaccent(coalesce(person.first_name, '') || ' ' || coalesce(person.last_name, '')))`;
    const emailVisible = !restrictedFields(actor).has('email');
    query = query.where((eb) =>
      eb.or([
        eb(name, 'like', plainLike),
        eb(nameRev, 'like', plainLike),
        // Typo tolerance via trigram similarity on the full name.
        sql<boolean>`word_similarity(${plain}, ${name}) > 0.5`,
        eb(sql`lower(member.membership_number)`, 'like', like),
        eb(sql`lower(person.city)`, 'like', like),
        ...(emailVisible ? [eb(sql`lower(person.email)`, 'like', like)] : []),
      ]),
    );
  }
  return query;
};

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  // Formula injection: spreadsheet software must show these as text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export const memberRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/members', { schema: { tags, summary: 'Mitglieder suchen und filtern (ehemalige standardmäßig ausgeblendet)', querystring: memberListQuery, response: { 200: memberList } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const today = await orgToday(db, actor.organizationId);
    // shortcut: the cursor is an opaque offset; switch to keyset pagination if lists grow past ~50k rows.
    const raw = req.query.cursor ? Buffer.from(req.query.cursor, 'base64url').toString() : '0';
    const offset = /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
    const order = { name: ['person.last_name', 'person.first_name', 'person.company_name'], number: ['member.membership_number'], joinDate: ['member.join_date'] }[req.query.sort];
    let query = listFilter(req.query, actor, today)(db).select([...memberColumns, sql<number>`count(*) over()`.as('total')]);
    for (const col of order) query = query.orderBy(sql.ref(col), sql`asc nulls last`);
    const rows = await query.orderBy('member.id').limit(req.query.limit).offset(offset).execute();
    const groups = await currentGroups(db, rows.map((r) => r.id), today);
    const hidden = restrictedFields(actor);
    const total = Number(rows[0]?.total ?? (offset === 0 ? 0 : (await listFilter(req.query, actor, today)(db).select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow()).n));
    const next = offset + rows.length < total ? Buffer.from(String(offset + rows.length)).toString('base64url') : null;
    return { items: rows.map((r) => toListItem(r, groups.get(r.id) ?? [], hidden)), total, nextCursor: next };
  });

  app.get('/members/ids', { schema: { tags, summary: 'Alle Treffer eines Filters auswählen: IDs (höchstens 5.000) und die ersten fünf Namen zur Bestätigung', querystring: memberListQuery.omit({ cursor: true, limit: true }), response: { 200: z.object({ ids: z.array(z.uuid()), total: z.number(), sample: z.array(z.string()) }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const today = await orgToday(db, actor.organizationId);
    const rows = await listFilter({ ...req.query, limit: 5000 }, actor, today)(db).select(['member.id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name']).orderBy('person.last_name').orderBy('person.first_name').orderBy('member.id').limit(5001).execute();
    if (rows.length > 5000) throw new Problem(422, 'too-many', 'Mehr als 5.000 Treffer.', 'Grenze den Filter weiter ein.');
    return { ids: rows.map((r) => r.id), total: rows.length, sample: rows.slice(0, 5).map((r) => displayName({ kind: r.kind, firstName: r.first_name, lastName: r.last_name, companyName: r.company_name })) };
  });

  app.get('/members/export.csv', { schema: { tags, summary: 'Gefilterte Mitgliederliste als CSV (UTF-8, Semikolon)', querystring: memberListQuery.omit({ cursor: true, limit: true }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const today = await orgToday(db, actor.organizationId);
    const hidden = restrictedFields(actor);
    const rows = await listFilter({ ...req.query, limit: 0 }, actor, today)(db).select(memberColumns).orderBy('person.last_name').orderBy('person.first_name').execute();
    const groups = await currentGroups(db, rows.map((r) => r.id), today);
    const columns: [string, string, (r: (typeof rows)[number]) => unknown][] = [
      ['Mitgliedsnummer', '', (r) => r.membership_number],
      ['Nachname', '', (r) => r.last_name],
      ['Vorname', '', (r) => r.first_name],
      ['Firma', '', (r) => r.company_name],
      ['Status', '', (r) => STATUS_LABEL[r.status]],
      ['E-Mail', 'email', (r) => r.email],
      ['Telefon', 'phone', (r) => r.phone],
      ['Straße', '', (r) => r.street],
      ['PLZ', '', (r) => r.postal_code],
      ['Ort', '', (r) => r.city],
      ['Land', '', (r) => r.country],
      ['Geburtsdatum', 'birth_date', (r) => r.birth_date],
      ['Eintritt', '', (r) => r.join_date],
      ['Austritt', '', (r) => r.exit_date],
      ['Gruppen', '', (r) => (groups.get(r.id) ?? []).map((g) => g.name).join(', ')],
      ...(await fieldsFor(db, actor)).map((f): [string, string, (r: (typeof rows)[number]) => unknown] => [f.label, '', (r) => customText(f.type, (r.custom as Record<string, unknown>)[f.id])]),
    ];
    const visible = columns.filter(([, field]) => !field || !hidden.has(field));
    const lines = [visible.map(([h]) => h).join(';'), ...rows.map((r) => visible.map(([, , get]) => csvCell(get(r))).join(';'))];
    await audit(db, actor.organizationId, actor, { action: 'member.export', entityType: 'member', diff: { filter: req.query, columns: visible.map(([h]) => h), rows: rows.length } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="mitglieder-${today}.csv"`);
    return '﻿' + lines.join('\r\n') + '\r\n';
  });

  app.get('/members/exit-proposal', { schema: { tags, summary: 'Austrittsdatum nach der Kündigungsregel des Vereins vorschlagen', querystring: z.object({ noticeDate: date }), response: { 200: z.object({ exitDate: z.string(), rule: z.string() }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const org = await db.selectFrom('organization').select(['notice_weeks', 'exit_at']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const at = { any_day: 'zu jedem Tag', month_end: 'zum Monatsende', quarter_end: 'zum Quartalsende', half_year_end: 'zum Halbjahresende', year_end: 'zum Jahresende' }[org.exit_at];
    return { exitDate: proposeExitDate(req.query.noticeDate, org.notice_weeks, org.exit_at), rule: `${org.notice_weeks} Wochen Frist ${at}` };
  });

  app.get('/members/:id', { schema: { tags, summary: 'Mitglied mit Gruppenverlauf und Zeitleiste (ETag für If-Match)', params: idParam, response: { 200: memberDetailSchema } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const m = await memberDetail(db, actor, req.params.id);
    setETag(reply, m.version);
    return m;
  });

  app.post('/members', { schema: { tags, summary: 'Mitglied anlegen (Person und Mitgliedschaft)', body: memberCreate, response: { 201: memberDetailSchema } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'write');
    assertWritable(actor, req.body);
    if (req.body.membershipNumber && !can(actor, 'settings', 'write')) throw forbidden('members.number.edit');
    const scope = scopeOf(actor, 'members', 'write');
    if (scope !== null && (req.body.groupIds.length === 0 || req.body.groupIds.some((g) => !scope.includes(g)))) {
      throw new Problem(403, 'out-of-scope', 'Du kannst Mitglieder nur in Deinen eigenen Gruppen anlegen.', 'Wähle mindestens eine Deiner Gruppen.', { permission: 'members:write' });
    }
    const today = await orgToday(db, actor.organizationId);
    const id = await db.transaction().execute((tx) => insertMember(tx, actor, req.body, today, 'member.created', null, true));
    reply.status(201);
    return memberDetail(db, actor, id);
  });

  app.patch(
    '/members/:id',
    { schema: { tags, summary: 'Stammdaten ändern (der Status ändert sich nur über die Aktionen)', params: idParam, body: memberPatch, response: { 200: memberDetailSchema } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'members', 'write');
      const body = req.body;
      assertWritable(actor, body);
      const { row, today } = await loadMemberRow(db, actor, req.params.id, 'write');
      const postalProblem = postalCodeProblem(body.postalCode ?? row.postal_code, body.country ?? row.country);
      if ((body.postalCode !== undefined || body.country !== undefined) && postalProblem) {
        throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'postalCode', message: postalProblem }] });
      }
      await db.transaction().execute(async (tx) => {
        // Optimistic concurrency: compare under row locks, so check and write are one step.
        const locked = await tx.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select(['member.updated_at as m', 'person.updated_at as p']).where('member.id', '=', row.id).forUpdate().executeTakeFirstOrThrow();
        assertIfMatch(req, versionOf(locked.m, locked.p));
        if (body.custom) await writeCustom(tx, actor, row.person_id, body.custom, 'patch');
        const person = personValues(body);
        if (Object.keys(person).length) {
          const before = await tx.selectFrom('person').selectAll().where('id', '=', row.person_id).forUpdate().executeTakeFirstOrThrow();
          await tx.updateTable('person').set({ ...person, updated_at: new Date() }).where('id', '=', row.person_id).execute();
          await audit(tx, actor.organizationId, actor, { action: 'person.updated', entityType: 'person', entityId: row.person_id, diff: diffOf(before as Record<string, unknown>, person) });
        }
        const memberChange: Record<string, unknown> = {};
        if (body.applicationDate !== undefined) memberChange.application_date = body.applicationDate;
        if (body.joinDate !== undefined && body.joinDate !== row.join_date) {
          if (row.status === 'applicant' || row.status === 'rejected') throw new Problem(400, 'not-admitted', 'Ein Antrag bekommt sein Eintrittsdatum über „Aufnehmen“.');
          memberChange.join_date = body.joinDate;
          if (row.status === 'future' || row.status === 'active') memberChange.status = statusForJoin(body.joinDate, today);
        }
        if (Object.keys(memberChange).length) {
          await tx.updateTable('member').set({ ...memberChange, updated_at: new Date() }).where('id', '=', row.id).execute();
          await audit(tx, actor.organizationId, actor, { action: 'member.updated', entityType: 'member', entityId: row.id, diff: diffOf(row as Record<string, unknown>, memberChange) });
        }
      });
      return memberDetail(db, actor, row.id);
    },
  );

  /** Shared body of the dated status transitions. */
  async function transition(
    actor: Actor,
    id: string,
    allowed: MemberStatus[],
    change: (row: Awaited<ReturnType<typeof loadMemberRow>>['row'], today: string) => Record<string, unknown> & { status: MemberStatus },
    action: string,
    after?: (tx: Db, row: Awaited<ReturnType<typeof loadMemberRow>>['row'], values: Record<string, unknown>) => Promise<void>,
  ) {
    requirePermission(actor, 'members', 'write');
    const { row, today } = await loadMemberRow(db, actor, id, 'write');
    await db.transaction().execute(async (tx) => {
      // Re-read the status under a row lock: two parallel actions (admit and reject) cannot both pass.
      const locked = await tx.selectFrom('member').select('status').where('id', '=', row.id).forUpdate().executeTakeFirstOrThrow();
      if (!allowed.includes(locked.status)) {
        throw new Problem(409, 'invalid-transition', `Das geht nicht bei Status „${STATUS_LABEL[locked.status]}“.`);
      }
      const values = change({ ...row, status: locked.status }, today);
      await tx.updateTable('member').set({ ...values, updated_at: new Date() }).where('id', '=', row.id).execute();
      await after?.(tx, row, values);
      await audit(tx, actor.organizationId, actor, { action, entityType: 'member', entityId: row.id, diff: diffOf(row as Record<string, unknown>, values) });
    });
  }

  app.post('/members/:id/resign', { schema: { tags, summary: 'Kündigung erfassen: Eingang der Kündigung und Austrittsdatum', params: idParam, body: resignBody, response: { 200: memberDetailSchema } } }, async (req) => {
    const actor = requireActor(req);
    const { noticeDate, exitDate, exitReason } = req.body;
    const org = await db.selectFrom('organization').select(['notice_weeks', 'exit_at']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const proposal = proposeExitDate(noticeDate, org.notice_weeks, org.exit_at);
    await transition(
      actor,
      req.params.id,
      ['active', 'future'],
      (row, today) => {
        if (row.join_date && exitDate < row.join_date) throw new Problem(400, 'exit-before-join', 'Das Austrittsdatum liegt vor dem Eintritt.', undefined, { errors: [{ field: 'exitDate', message: 'Liegt vor dem Eintrittsdatum.' }] });
        return { status: exitDate < today ? 'former' : 'resigned', notice_date: noticeDate, exit_date: exitDate, exit_reason: exitReason };
      },
      'member.resigned',
      // Group memberships end with the membership.
      (tx, row) => tx.updateTable('group_membership').set({ valid_to: exitDate }).where('member_id', '=', row.id).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', exitDate)])).where('valid_from', '<=', exitDate).execute().then(() => undefined),
    );
    const warn = exitDate < proposal ? [`Das Austrittsdatum liegt vor dem frühesten Termin laut Satzung (${proposal}).`] : [];
    return memberDetail(db, actor, req.params.id, warn);
  });

  app.post('/members/:id/withdraw-resignation', { schema: { tags, summary: 'Kündigung zurücknehmen', params: idParam, body: z.object({}).optional(), response: { 200: memberDetailSchema } } }, async (req) => {
    const actor = requireActor(req);
    await transition(
      actor,
      req.params.id,
      ['resigned'],
      (row, today) => ({ status: statusForJoin(row.join_date!, today), notice_date: null, exit_date: null, exit_reason: null }),
      'member.resignation_withdrawn',
      // Reopen the group memberships that the resignation closed.
      (tx, row) => tx.updateTable('group_membership').set({ valid_to: null }).where('member_id', '=', row.id).where('valid_to', '=', row.exit_date!).execute().then(() => undefined),
    );
    return memberDetail(db, actor, req.params.id);
  });

  app.post('/members/:id/admit', { schema: { tags, summary: 'Antrag annehmen und Eintrittsdatum setzen', params: idParam, body: z.object({ joinDate: date }), response: { 200: memberDetailSchema } } }, async (req) => {
    const actor = requireActor(req);
    await transition(actor, req.params.id, ['applicant'], (_row, today) => ({ status: statusForJoin(req.body.joinDate, today), join_date: req.body.joinDate }), 'member.admitted');
    return memberDetail(db, actor, req.params.id);
  });

  app.post('/members/:id/reject', { schema: { tags, summary: 'Antrag ablehnen', params: idParam, body: z.object({}).optional(), response: { 200: memberDetailSchema } } }, async (req) => {
    const actor = requireActor(req);
    await transition(actor, req.params.id, ['applicant'], () => ({ status: 'rejected' }), 'member.rejected');
    return memberDetail(db, actor, req.params.id);
  });

  app.post('/members/bulk', { schema: { tags, summary: 'Gruppenzugehörigkeit für viele Mitglieder auf einmal ändern (über 100 Mitglieder als Hintergrundaufgabe, Antwort 202)', body: bulkBody, response: { 200: bulkResult, 202: jobSchema } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'write');
    await assertGroup(db, actor, req.body.groupId);
    if (req.body.ids.length > BULK_INLINE_MAX) {
      // The selection is frozen now; the job re-checks the starting user's rights and scope when it runs.
      const job = await db.insertInto('job').values({ organization_id: actor.organizationId, kind: 'member_bulk', created_by: actor.userId, params: JSON.stringify(req.body) }).returningAll().executeTakeFirstOrThrow();
      reply.status(202);
      return jobDto(job);
    }
    return memberBulk(db, actor, req.body);
  });
};

/** Person, membership (number from the pattern) and group memberships in the caller's transaction. */
/** `requireCustom`: only the create form can ask for the club's required custom fields; imports and admitted applications cannot. */
export async function insertMember(tx: Db, actor: Actor, body: z.output<typeof memberCreate>, today: string, action = 'member.created', importRunId: string | null = null, requireCustom = false) {
  const org = await tx.selectFrom('organization').select('member_number_pattern').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
  const person = await tx
    .insertInto('person')
    .values({ organization_id: actor.organizationId, ...(personValues(body) as { last_name: string }), import_run_id: importRunId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await writeCustom(tx, actor, person.id, body.custom, requireCustom ? 'create' : 'patch');
  const status: MemberStatus = body.joinDate ? statusForJoin(body.joinDate, today) : 'applicant';
  const taken = async (n: string) => !!(await tx.selectFrom('member').select('id').where('organization_id', '=', actor.organizationId).where('membership_number', '=', n).executeTakeFirst());
  const number = body.membershipNumber ?? (await nextNumber(tx, actor.organizationId, 'member', org.member_number_pattern, body.joinDate ?? today, taken));
  const member = await tx
    .insertInto('member')
    .values({
      organization_id: actor.organizationId,
      person_id: person.id,
      membership_number: number,
      status,
      join_date: body.joinDate ?? null,
      application_date: body.applicationDate ?? (status === 'applicant' ? today : null),
      import_run_id: importRunId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const groupId of body.groupIds) {
    await assertGroup(tx, actor, groupId);
    await tx.insertInto('group_membership').values({ organization_id: actor.organizationId, member_id: member.id, group_id: groupId, valid_from: body.joinDate ?? today, import_run_id: importRunId }).execute();
  }
  await audit(tx, actor.organizationId, actor, { action, entityType: 'member', entityId: member.id, diff: { status: [null, status], membershipNumber: [null, number] } });
  return member.id;
}
