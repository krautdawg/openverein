import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { isValidIban, normalizeIban } from '../../shared/iban.ts';
import { parseCsv, parseDate, suggestMapping, TARGETS, type Target } from '../../shared/import.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { orgToday } from '../members/query.ts';
import { requirePermission, scopeOf, type Actor } from '../policy.ts';
import { insertMember } from './members.ts';
import { insertMandate } from './sepa.ts';

const tags = ['imports'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const targetEnum = z.enum(Object.keys(TARGETS) as [Target, ...Target[]]);

const importInput = z.object({
  fileName: z.string().max(200).optional(),
  content: z.string().max(MAX_BYTES, 'Die Datei ist größer als 5 MB.'),
  mapping: z.record(z.string(), targetEnum.nullable()).optional(),
  matchKey: z.enum(['number', 'email', 'name_birth']).default('number'),
  preset: z.enum(['easyverein', 'generic']).default('generic'),
});
const rowResult = z.object({ line: z.number(), action: z.enum(['create', 'update', 'skip', 'error']), name: z.string(), messages: z.array(z.string()) });
const previewDto = z.object({
  headers: z.array(z.string()),
  mapping: z.record(z.string(), targetEnum.nullable()),
  unmapped: z.array(z.string()),
  rows: z.array(rowResult),
  counts: z.object({ create: z.number(), update: z.number(), skip: z.number(), error: z.number() }),
  newGroups: z.array(z.string()),
});
const runDto = z.object({ id: z.uuid(), fileName: z.string().nullable(), preset: z.string().nullable(), counts: z.record(z.string(), z.number()), createdAt: z.string(), rolledBackAt: z.string().nullable() });

type Row = Partial<Record<Target, string>>;
interface Planned {
  line: number;
  action: 'create' | 'update' | 'skip' | 'error';
  name: string;
  messages: string[];
  row: Row;
  memberId?: string;
  personId?: string;
}

export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  const guard = (actor: Actor) => {
    requirePermission(actor, 'imports', 'write');
    requirePermission(actor, 'members', 'write');
    if (scopeOf(actor, 'members', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Importe laufen für den ganzen Verein.', { permission: 'members:write (ganzer Verein)' });
  };

  /** Reads and validates every row exactly like the UI would, and decides create / update / skip / error. */
  async function plan(actor: Actor, body: z.infer<typeof importInput>) {
    const table = parseCsv(body.content);
    if (table.length < 2) throw new Problem(400, 'empty', 'Die Datei enthält keine Datenzeilen.');
    if (table.length - 1 > MAX_ROWS) throw new Problem(400, 'too-many-rows', `Höchstens ${MAX_ROWS} Zeilen pro Import.`);
    const headers = table[0]!.map((h) => h.trim());
    const mapping = body.mapping ?? suggestMapping(headers);
    const existingGroups = await db.selectFrom('club_group').select(['id', 'name']).where('organization_id', '=', actor.organizationId).execute();
    const newGroups = new Set<string>();
    const seen = new Set<string>();
    const planned: Planned[] = [];
    for (let i = 1; i < table.length; i++) {
      const cells = table[i]!;
      const row: Row = {};
      headers.forEach((h, j) => {
        const t = mapping[h];
        if (t && cells[j]?.trim()) row[t] = cells[j]!.trim();
      });
      const name = [row.lastName ?? row.companyName, row.firstName].filter(Boolean).join(', ') || `Zeile ${i + 1}`;
      const messages: string[] = [];
      if (!row.lastName && !row.companyName) messages.push('Nachname oder Firma fehlt.');
      for (const k of ['birthDate', 'joinDate', 'exitDate', 'mandateDate'] as const) {
        if (row[k] && !parseDate(row[k]!)) messages.push(`${TARGETS[k].label} „${row[k]}“ ist kein Datum.`);
      }
      if (!row.joinDate) messages.push('Eintrittsdatum fehlt.');
      if (row.email && !z.email().safeParse(row.email).success) messages.push(`E-Mail „${row.email}“ ist ungültig.`);
      if (row.iban && !isValidIban(normalizeIban(row.iban))) messages.push('IBAN ist ungültig.');
      if (row.iban && !row.mandateDate) messages.push('IBAN ohne Mandatsdatum: Das Mandat wird nicht übernommen.');
      if (row.mandateReference && !/^[A-Za-z0-9/?:().,'+ -]{1,35}$/.test(row.mandateReference)) messages.push('Mandatsreferenz enthält unzulässige Zeichen.');
      const errors = messages.filter((m) => !m.startsWith('IBAN ohne Mandatsdatum'));
      const key = body.matchKey === 'number' ? row.membershipNumber : body.matchKey === 'email' ? row.email?.toLowerCase() : row.lastName && row.birthDate ? `${row.lastName.toLowerCase()}|${parseDate(row.birthDate)}` : undefined;
      if (key && seen.has(key)) {
        planned.push({ line: i + 1, action: 'skip', name, messages: ['Kommt in der Datei doppelt vor.'], row });
        continue;
      }
      if (key) seen.add(key);
      for (const g of (row.groups ?? '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean)) if (!existingGroups.some((e) => e.name.toLowerCase() === g.toLowerCase())) newGroups.add(g);
      if (errors.length) {
        planned.push({ line: i + 1, action: 'error', name, messages, row });
        continue;
      }
      // Match an existing member by the chosen key.
      let q = db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select(['member.id', 'member.person_id']).where('member.organization_id', '=', actor.organizationId);
      if (body.matchKey === 'number') q = row.membershipNumber ? q.where('member.membership_number', '=', row.membershipNumber) : q.where(sql<boolean>`false`);
      else if (body.matchKey === 'email') q = row.email ? q.where(sql<boolean>`lower(person.email) = ${row.email.toLowerCase()}`) : q.where(sql<boolean>`false`);
      else q = row.lastName && row.birthDate ? q.where('person.last_name', 'ilike', row.lastName).where('person.birth_date', '=', parseDate(row.birthDate)) : q.where(sql<boolean>`false`);
      const match = await q.executeTakeFirst();
      planned.push({ line: i + 1, action: match ? 'update' : 'create', name, messages, row, memberId: match?.id, personId: match?.person_id });
    }
    const counts = { create: 0, update: 0, skip: 0, error: 0 };
    for (const p of planned) counts[p.action]++;
    return { headers, mapping, unmapped: headers.filter((h) => !mapping[h]), planned, counts, newGroups: [...newGroups] };
  }

  app.post('/imports/members/preview', { bodyLimit: MAX_BYTES * 2, schema: { tags, summary: 'Mitglieder-Import probelaufen lassen (schreibt nichts)', body: importInput, response: { 200: previewDto } } }, async (req) => {
    const actor = requireActor(req);
    guard(actor);
    const p = await plan(actor, req.body);
    return { ...p, rows: p.planned.map(({ line, action, name, messages }) => ({ line, action, name, messages })) };
  });

  app.post('/imports/members', { bodyLimit: MAX_BYTES * 2, schema: { tags, summary: 'Mitglieder importieren (Zeilen mit Fehlern werden übersprungen)', body: importInput, response: { 201: runDto } } }, async (req, reply) => {
    const actor = requireActor(req);
    guard(actor);
    const p = await plan(actor, req.body);
    const today = await orgToday(db, actor.organizationId);
    const run = await db.transaction().execute(async (tx) => {
      const run = await tx.insertInto('import_run').values({ organization_id: actor.organizationId, file_name: req.body.fileName ?? null, file_sha256: createHash('sha256').update(req.body.content).digest('hex'), preset: req.body.preset, counts: JSON.stringify(p.counts), created_by: actor.userId }).returningAll().executeTakeFirstOrThrow();
      const groupIds = new Map<string, string>((await tx.selectFrom('club_group').select(['id', 'name']).where('organization_id', '=', actor.organizationId).execute()).map((g) => [g.name.toLowerCase(), g.id]));
      for (const name of p.newGroups) {
        const g = await tx.insertInto('club_group').values({ organization_id: actor.organizationId, name, short_code: shortCode(name, groupIds.size), import_run_id: run.id } as never).returning('id').executeTakeFirstOrThrow();
        groupIds.set(name.toLowerCase(), g.id);
      }
      for (const r of p.planned) {
        if (r.action !== 'create' && r.action !== 'update') continue;
        await applyRow(tx, actor, run.id, r, groupIds, today);
      }
      await audit(tx, actor.organizationId, actor, { action: 'import.members', entityType: 'import_run', entityId: run.id, diff: { counts: [null, p.counts], file: [null, req.body.fileName ?? null] } });
      return run;
    });
    reply.status(201);
    return toRunDto(run);
  });

  async function applyRow(tx: Db, actor: Actor, runId: string, r: Planned, groupIds: Map<string, string>, today: string) {
    const row = r.row;
    const d = (v?: string) => (v ? parseDate(v) : null);
    const person = {
      kind: row.companyName && !row.firstName ? ('organisation' as const) : ('natural' as const),
      firstName: row.firstName ?? null,
      lastName: row.lastName ?? null,
      companyName: row.companyName ?? null,
      birthDate: d(row.birthDate),
      email: row.email ?? null,
      phone: row.phone ?? null,
      street: row.street ?? null,
      postalCode: row.postalCode ?? null,
      city: row.city ?? null,
      country: row.country && /^[A-Za-z]{2}$/.test(row.country) ? row.country.toUpperCase() : 'DE',
      note: row.note ?? null,
    };
    const groups = (row.groups ?? '').split(/[,;|]/).map((x) => groupIds.get(x.trim().toLowerCase())).filter((x): x is string => !!x);
    const joinDate = d(row.joinDate)!;
    const exitDate = d(row.exitDate);
    let memberId = r.memberId;
    let personId = r.personId;
    if (r.action === 'create') {
      memberId = await insertMember(tx, actor, { ...person, preferredChannel: 'email', joinDate, applicationDate: null, groupIds: [...new Set(groups)], membershipNumber: row.membershipNumber }, today, 'member.imported');
      const m = await tx.updateTable('member').set({ import_run_id: runId }).where('id', '=', memberId).returning('person_id').executeTakeFirstOrThrow();
      personId = m.person_id;
      await tx.updateTable('person').set({ import_run_id: runId }).where('id', '=', personId).execute();
      await tx.updateTable('group_membership').set({ import_run_id: runId }).where('member_id', '=', memberId).execute();
    } else {
      // Updates fill in what the file has; empty cells never erase existing data.
      const set = Object.fromEntries(Object.entries({ first_name: person.firstName, last_name: person.lastName, company_name: person.companyName, birth_date: person.birthDate, email: person.email, phone: person.phone, street: person.street, postal_code: person.postalCode, city: person.city }).filter(([, v]) => v !== null));
      if (Object.keys(set).length) await tx.updateTable('person').set({ ...set, updated_at: new Date() }).where('id', '=', personId!).execute();
      // Members who already left get no new group memberships.
      for (const g of exitDate && exitDate < today ? [] : new Set(groups)) {
        const has = await tx.selectFrom('group_membership').select('id').where('member_id', '=', memberId!).where('group_id', '=', g).where('valid_to', 'is', null).executeTakeFirst();
        if (!has) await tx.insertInto('group_membership').values({ organization_id: actor.organizationId, member_id: memberId!, group_id: g, valid_from: today, import_run_id: runId }).execute();
      }
      await audit(tx, actor.organizationId, actor, { action: 'member.updated', entityType: 'member', entityId: memberId!, diff: { source: [null, 'import'], fields: [null, Object.keys(set)] } });
    }
    if (exitDate) {
      const left = await tx.updateTable('member').set({ status: exitDate < today ? 'former' : 'resigned', exit_date: exitDate, notice_date: exitDate < today ? exitDate : today, updated_at: new Date() }).where('id', '=', memberId!).where('status', 'in', ['active', 'future']).executeTakeFirst();
      if (Number(left.numUpdatedRows)) await tx.updateTable('group_membership').set({ valid_to: exitDate }).where('member_id', '=', memberId!).where('valid_to', 'is', null).where('valid_from', '<=', exitDate).execute();
    }
    if (row.iban && row.mandateDate) {
      const iban = normalizeIban(row.iban);
      const number = (await tx.selectFrom('member').select('membership_number').where('id', '=', memberId!).executeTakeFirstOrThrow()).membership_number;
      const sameRef = row.mandateReference ? await tx.selectFrom('sepa_mandate').select('id').where('organization_id', '=', actor.organizationId).where('reference', '=', row.mandateReference).executeTakeFirst() : undefined;
      if (!sameRef) {
        // Signed mandates from the old system stay valid; the creditor ID and reference are kept, so debits continue as recurring.
        const m = await insertMandate(tx, actor, { personId: personId!, memberId: memberId!, membershipNumber: number, today, reference: row.mandateReference, signedOn: d(row.mandateDate)!, accountHolder: row.accountHolder || [row.firstName, row.lastName].filter(Boolean).join(' ') || row.companyName || 'Kontoinhaber', iban, bic: row.bic ?? null, type: 'recurrent', pendingEvidence: false });
        await tx.updateTable('sepa_mandate').set({ import_run_id: runId, first_collected: true }).where('id', '=', m.id).execute();
        await tx.updateTable('member').set({ payment_method: 'direct_debit' }).where('id', '=', memberId!).execute();
      }
    }
  }

  const toRunDto = (r: { id: string; file_name: string | null; preset: string | null; counts: unknown; created_at: Date; rolled_back_at: Date | null }) => ({ id: r.id, fileName: r.file_name, preset: r.preset, counts: r.counts as Record<string, number>, createdAt: r.created_at.toISOString(), rolledBackAt: r.rolled_back_at?.toISOString() ?? null });

  app.get('/imports', { schema: { tags, summary: 'Bisherige Importe', response: { 200: z.array(runDto) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'imports', 'read');
    return (await db.selectFrom('import_run').selectAll().where('organization_id', '=', actor.organizationId).orderBy('created_at', 'desc').execute()).map(toRunDto);
  });

  app.post('/imports/:id/rollback', { schema: { tags, summary: 'Import rückgängig machen (nur solange nichts darauf aufbaut; Änderungen an vorhandenen Mitgliedern bleiben)', params: z.object({ id: z.uuid() }), body: z.object({}).optional(), response: { 200: runDto } } }, async (req) => {
    const actor = requireActor(req);
    guard(actor);
    const run = await db.transaction().execute(async (tx) => {
      const run = await tx.selectFrom('import_run').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!run) throw notFound('Import');
      if (run.rolled_back_at) throw new Problem(409, 'rolled-back', 'Dieser Import ist schon rückgängig gemacht.');
      const members = tx.selectFrom('member').select('id').where('import_run_id', '=', run.id);
      const persons = tx.selectFrom('person').select('id').where('import_run_id', '=', run.id);
      // Name what depends on the imported records instead of failing on a foreign key.
      const blockers: [string, () => Promise<unknown>][] = [
        ['Rechnungen', () => tx.selectFrom('invoice').select('id').where('recipient_person_id', 'in', persons).executeTakeFirst()],
        ['Beitragszuordnungen', () => tx.selectFrom('fee_assignment').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['Lastschriften', () => tx.selectFrom('collection_item').innerJoin('sepa_mandate', 'sepa_mandate.id', 'collection_item.mandate_id').select('collection_item.id').where('sepa_mandate.import_run_id', '=', run.id).executeTakeFirst()],
        ['Terminrückmeldungen', () => tx.selectFrom('participation').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['E-Mails', () => tx.selectFrom('delivery').select('id').where('person_id', 'in', persons).executeTakeFirst()],
        ['Dateien', () => tx.selectFrom('file').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['Änderungswünsche', () => tx.selectFrom('change_request').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['Gruppenmitgliedschaften anderer Mitglieder', () => tx.selectFrom('group_membership').innerJoin('club_group', 'club_group.id', 'group_membership.group_id').select('group_membership.id').where('club_group.import_run_id', '=', run.id).where((eb) => eb.or([eb('group_membership.import_run_id', 'is', null), eb('group_membership.import_run_id', '!=', run.id)])).executeTakeFirst()],
      ];
      for (const [label, check] of blockers) if (await check()) throw new Problem(409, 'has-dependents', 'Der Import lässt sich nicht mehr zurücknehmen.', `Darauf bauen schon ${label} auf.`);
      await tx.deleteFrom('group_membership').where('import_run_id', '=', run.id).execute();
      await tx.deleteFrom('sepa_mandate').where('import_run_id', '=', run.id).execute();
      await tx.deleteFrom('member').where('import_run_id', '=', run.id).execute();
      await tx.deleteFrom('person').where('import_run_id', '=', run.id).execute();
      await tx.deleteFrom('club_group').where('import_run_id', '=', run.id).execute();
      const after = await tx.updateTable('import_run').set({ rolled_back_at: new Date() }).where('id', '=', run.id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'import.rolled_back', entityType: 'import_run', entityId: run.id });
      return after;
    });
    return toRunDto(run);
  });
};

/** Short code for a new group: letters of the name, unique enough for an import (admins can rename). */
function shortCode(name: string, n: number) {
  const letters = name.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'GRP';
  return `${letters}${n + 1}`.slice(0, 10);
}
