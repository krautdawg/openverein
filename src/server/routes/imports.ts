import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { isValidIban, normalizeIban } from '../../shared/iban.ts';
import { countryCode, parseCsvLines, parseDate, suggestMapping, TARGETS, uniqueHeaders, type Target } from '../../shared/import.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { blindIndex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { orgToday } from '../members/query.ts';
import { requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';
import { insertMember } from './members.ts';
import { insertMandate } from './sepa.ts';

const tags = ['imports'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const targetEnum = z.enum(Object.keys(TARGETS) as [Target, ...Target[]]);
// Import targets and the person column a role may have hidden.
const FIELD_OF: Partial<Record<Target, string>> = { birthDate: 'birth_date', email: 'email', phone: 'phone', note: 'note', street: 'street', iban: 'iban', bic: 'iban', accountHolder: 'iban', mandateReference: 'iban', mandateDate: 'iban' };

const importInput = z.object({
  fileName: z.string().max(200).optional(),
  content: z.string().max(MAX_BYTES, 'Die Datei ist größer als 5 MB.'),
  mapping: z.record(z.string(), targetEnum.nullable()).optional(),
  matchKey: z.enum(['number', 'email', 'name_birth']).default('number'),
  preset: z.enum(['easyverein', 'generic']).default('generic'),
  /** From the dry run: the import only runs on exactly what was previewed. */
  planHash: z.string().max(100).optional(),
});
const rowResult = z.object({ line: z.number(), action: z.enum(['create', 'update', 'skip', 'error']), name: z.string(), messages: z.array(z.string()) });
const countsDto = z.object({ create: z.number(), update: z.number(), skip: z.number(), error: z.number() });
const previewDto = z.object({
  headers: z.array(z.string()),
  mapping: z.record(z.string(), targetEnum.nullable()),
  unmapped: z.array(z.string()),
  rows: z.array(rowResult),
  counts: countsDto,
  newGroups: z.array(z.string()),
  planHash: z.string(),
  alreadyImportedAt: z.string().nullable(),
});
const runDto = z.object({ id: z.uuid(), fileName: z.string().nullable(), preset: z.string().nullable(), counts: z.record(z.string(), z.number()), createdAt: z.string(), rolledBackAt: z.string().nullable(), rows: z.array(rowResult).optional() });

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

const like = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const splitGroups = (v?: string) => [...new Map((v ?? '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean).map((x) => [x.toLowerCase(), x])).values()];

export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  const guard = (actor: Actor) => {
    requirePermission(actor, 'imports', 'write');
    requirePermission(actor, 'members', 'write');
    if (scopeOf(actor, 'members', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Importe laufen für den ganzen Verein.', { permission: 'members:write (ganzer Verein)' });
  };

  /** Validates every row with the rules the database enforces, and decides create / update / skip / error. */
  async function plan(q: Db, actor: Actor, body: z.infer<typeof importInput>) {
    let table: { cells: string[]; line: number }[];
    try {
      table = parseCsvLines(body.content);
    } catch (err) {
      throw new Problem(400, 'csv', 'Die Datei lässt sich nicht lesen.', (err as Error).message);
    }
    if (table.length < 2) throw new Problem(400, 'empty', 'Die Datei enthält keine Datenzeilen.');
    if (table.length - 1 > MAX_ROWS) throw new Problem(400, 'too-many-rows', `Höchstens ${MAX_ROWS} Zeilen pro Import.`);
    const headers = uniqueHeaders(table[0]!.cells);
    const mapping = body.mapping ?? suggestMapping(headers);
    // Bank data and hidden fields need the same rights as entering them by hand.
    const mapped = new Set(Object.values(mapping).filter((t): t is Target => !!t));
    const hidden = restrictedFields(actor);
    for (const t of mapped) {
      const col = FIELD_OF[t];
      if (col && hidden.has(col)) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', `Die Spalte „${TARGETS[t].label}“ darfst Du nicht sehen, also auch nicht importieren.`, { permission: `members.field.${col}` });
    }
    // Same gate as entering a mandate by hand, including the second factor.
    if (mapped.has('iban')) requirePermission(actor, 'sepa', 'write');

    const today = await orgToday(q, actor.organizationId);
    const groups = await q.selectFrom('club_group').select(['id', 'name', 'archived_at']).where('organization_id', '=', actor.organizationId).execute();
    const newGroups = new Map<string, string>();
    const seenKeys = new Set<string>();
    const seenNumbers = new Set<string>();
    const planned: Planned[] = [];
    for (const { cells, line } of table.slice(1)) {
      const row: Row = {};
      headers.forEach((h, j) => {
        const t = mapping[h];
        if (t && cells[j]?.trim()) row[t] = cells[j]!.trim();
      });
      const name = [row.lastName ?? row.companyName, row.firstName].filter(Boolean).join(', ') || `Zeile ${line}`;
      const errors: string[] = [];
      const notes: string[] = [];
      if (cells.length > headers.length && cells.slice(headers.length).some((c) => c.trim())) notes.push('Die Zeile hat mehr Spalten als die Kopfzeile; der Rest wird ignoriert.');
      if (!row.lastName && !row.companyName) errors.push('Nachname oder Firma fehlt.');
      for (const k of ['birthDate', 'joinDate', 'exitDate', 'mandateDate'] as const) {
        if (row[k] && !parseDate(row[k]!)) errors.push(`${TARGETS[k].label} „${row[k]}“ ist kein Datum.`);
      }
      if (!row.joinDate) errors.push('Eintrittsdatum fehlt.');
      const join = row.joinDate ? parseDate(row.joinDate) : null;
      const exit = row.exitDate ? parseDate(row.exitDate) : null;
      if (row.email && !z.email().safeParse(row.email).success) errors.push(`E-Mail „${row.email}“ ist ungültig.`);
      if (row.iban && !isValidIban(normalizeIban(row.iban))) errors.push('IBAN ist ungültig.');
      if (row.iban && !row.mandateDate) notes.push('IBAN ohne Mandatsdatum: Das Mandat wird nicht übernommen.');
      if (row.mandateReference && !/^[A-Za-z0-9/?:().,'+ -]{1,35}$/.test(row.mandateReference)) errors.push('Mandatsreferenz enthält unzulässige Zeichen.');
      if (row.country && !countryCode(row.country)) notes.push(`Land „${row.country}“ unbekannt; es bleibt Deutschland.`);
      if (row.membershipNumber && row.membershipNumber.length > 40) errors.push('Mitgliedsnummer ist länger als 40 Zeichen.');
      for (const g of splitGroups(row.groups)) {
        const known = groups.find((e) => e.name.toLowerCase() === g.toLowerCase());
        if (g.length > 120) errors.push(`Gruppenname „${g.slice(0, 30)}…“ ist zu lang.`);
        else if (known?.archived_at) errors.push(`Gruppe „${known.name}“ ist archiviert.`);
        else if (!known && !newGroups.has(g.toLowerCase())) newGroups.set(g.toLowerCase(), g);
      }
      const key = body.matchKey === 'number' ? row.membershipNumber : body.matchKey === 'email' ? (row.email ? `${row.email.toLowerCase()}|${(row.firstName ?? '').toLowerCase()}` : undefined) : row.lastName && row.birthDate ? `${row.lastName.toLowerCase()}|${parseDate(row.birthDate)}` : undefined;
      if (errors.length) {
        planned.push({ line, action: 'error', name, messages: [...errors, ...notes], row });
        continue;
      }
      // Only valid rows claim their key, so a later corrected row is not skipped.
      if (key && seenKeys.has(key)) {
        planned.push({ line, action: 'skip', name, messages: ['Kommt in der Datei doppelt vor.'], row });
        continue;
      }
      if (key) seenKeys.add(key);
      // Match an existing member by the chosen key (families share e-mail addresses, so the first name counts too).
      let m = q.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select(['member.id', 'member.person_id', 'member.join_date', 'member.membership_number']).where('member.organization_id', '=', actor.organizationId);
      if (body.matchKey === 'number') m = row.membershipNumber ? m.where('member.membership_number', '=', row.membershipNumber) : m.where(sql<boolean>`false`);
      else if (body.matchKey === 'email') m = row.email ? m.where(sql<boolean>`lower(person.email) = ${row.email.toLowerCase()}`).where('person.first_name', 'ilike', like(row.firstName ?? '')) : m.where(sql<boolean>`false`);
      else m = row.lastName && row.birthDate ? m.where('person.last_name', 'ilike', like(row.lastName)).where('person.birth_date', '=', parseDate(row.birthDate)) : m.where(sql<boolean>`false`);
      const match = await m.executeTakeFirst();
      const effectiveJoin = match ? match.join_date : join;
      if (exit && effectiveJoin && exit < effectiveJoin) {
        planned.push({ line, action: 'error', name, messages: ['Austritt liegt vor dem Eintritt.'], row });
        continue;
      }
      if (!match && row.membershipNumber) {
        const taken = (await q.selectFrom('member').select('id').where('organization_id', '=', actor.organizationId).where('membership_number', '=', row.membershipNumber).executeTakeFirst()) || seenNumbers.has(row.membershipNumber);
        if (taken) {
          planned.push({ line, action: 'error', name, messages: [`Mitgliedsnummer ${row.membershipNumber} ist schon vergeben.`], row });
          continue;
        }
        seenNumbers.add(row.membershipNumber);
      }
      planned.push({ line, action: match ? 'update' : 'create', name, messages: notes, row, memberId: match?.id, personId: match?.person_id });
    }
    const c = { create: 0, update: 0, skip: 0, error: 0 };
    for (const p of planned) c[p.action]++;
    const planHash = createHash('sha256').update(JSON.stringify([body.content, mapping, body.matchKey])).digest('hex').slice(0, 32);
    return { headers, mapping, unmapped: headers.filter((h) => !mapping[h]), planned, counts: c, newGroups: [...newGroups.values()], planHash, today };
  }

  app.post('/imports/members/preview', { bodyLimit: MAX_BYTES * 2, schema: { tags, summary: 'Mitglieder-Import probelaufen lassen (schreibt nichts)', body: importInput, response: { 200: previewDto } } }, async (req) => {
    const actor = requireActor(req);
    guard(actor);
    const p = await plan(db, actor, req.body);
    const sha = createHash('sha256').update(req.body.content).digest('hex');
    const earlier = await db.selectFrom('import_run').select('created_at').where('organization_id', '=', actor.organizationId).where('file_sha256', '=', sha).where('rolled_back_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirst();
    return { headers: p.headers, mapping: p.mapping, unmapped: p.unmapped, counts: p.counts, newGroups: p.newGroups, planHash: p.planHash, alreadyImportedAt: earlier?.created_at.toISOString() ?? null, rows: p.planned.map(({ line, action, name, messages }) => ({ line, action, name, messages })) };
  });

  app.post('/imports/members', { bodyLimit: MAX_BYTES * 2, schema: { tags, summary: 'Mitglieder importieren, wie im Probelauf gezeigt (Zeilen mit Fehlern werden übersprungen)', body: importInput.extend({ planHash: z.string().max(100) }), response: { 201: runDto } } }, async (req, reply) => {
    const actor = requireActor(req);
    guard(actor);
    const result = await db.transaction().execute(async (tx) => {
      // One import at a time per club; the plan is recomputed under the lock and must match the dry run.
      await sql`select pg_advisory_xact_lock(hashtext(${`import:${actor.organizationId}`}))`.execute(tx);
      const p = await plan(tx, actor, req.body);
      if (p.planHash !== req.body.planHash) throw new Problem(409, 'plan-changed', 'Datei oder Einstellungen haben sich seit dem Probelauf geändert.', 'Starte den Probelauf neu.');
      const run = await tx.insertInto('import_run').values({ organization_id: actor.organizationId, file_name: req.body.fileName ?? null, file_sha256: createHash('sha256').update(req.body.content).digest('hex'), preset: req.body.preset, created_by: actor.userId }).returningAll().executeTakeFirstOrThrow();
      const groupIds = new Map<string, string>((await tx.selectFrom('club_group').select(['id', 'name']).where('organization_id', '=', actor.organizationId).execute()).map((g) => [g.name.toLowerCase(), g.id]));
      const codes = new Set((await tx.selectFrom('club_group').select('short_code').where('organization_id', '=', actor.organizationId).execute()).map((g) => g.short_code));
      for (const name of p.newGroups) {
        const g = await tx.insertInto('club_group').values({ organization_id: actor.organizationId, name, short_code: shortCode(name, codes), import_run_id: run.id }).returning('id').executeTakeFirstOrThrow();
        groupIds.set(name.toLowerCase(), g.id);
      }
      for (const r of p.planned) {
        if (r.action !== 'create' && r.action !== 'update') continue;
        // Each row in its own savepoint: a rejection the dry run could not foresee fails that row, not the file.
        await sql`savepoint import_row`.execute(tx);
        try {
          r.messages.push(...(await applyRow(tx, actor, run.id, r, groupIds, p.today)));
          await sql`release savepoint import_row`.execute(tx);
        } catch (err) {
          await sql`rollback to savepoint import_row`.execute(tx);
          r.action = 'error';
          r.messages = [err instanceof Problem ? `${err.message} ${err.detail ?? ''}`.trim() : 'Die Datenbank hat die Zeile abgelehnt.'];
        }
      }
      const c = { create: 0, update: 0, skip: 0, error: 0 };
      for (const x of p.planned) c[x.action]++;
      const after = await tx.updateTable('import_run').set({ counts: JSON.stringify(c) }).where('id', '=', run.id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'import.members', entityType: 'import_run', entityId: run.id, diff: { counts: [null, c], file: [null, req.body.fileName ?? null] } });
      return { run: after, rows: p.planned };
    });
    reply.status(201);
    return { ...toRunDto(result.run), rows: result.rows.filter((r) => r.action === 'error' || r.messages.length).map(({ line, action, name, messages }) => ({ line, action, name, messages })) };
  });

  /** Writes one row; returns notes for the report. */
  async function applyRow(tx: Db, actor: Actor, runId: string, r: Planned, groupIds: Map<string, string>, today: string): Promise<string[]> {
    const row = r.row;
    const notes: string[] = [];
    const d = (v?: string) => (v ? parseDate(v) : null);
    const organisation = !!row.companyName && !row.lastName;
    const person = {
      kind: organisation ? ('organisation' as const) : ('natural' as const),
      firstName: organisation ? null : (row.firstName ?? null),
      lastName: row.lastName ?? null,
      companyName: row.companyName ?? null,
      birthDate: d(row.birthDate),
      email: row.email ?? null,
      phone: row.phone ?? null,
      street: row.street ?? null,
      postalCode: row.postalCode ?? null,
      city: row.city ?? null,
      country: (row.country && countryCode(row.country)) || 'DE',
      note: row.note ?? null,
    };
    const exitDate = d(row.exitDate);
    const left = !!exitDate && exitDate < today;
    const groups = [...new Set(splitGroups(row.groups).map((g) => groupIds.get(g.toLowerCase())).filter((x): x is string => !!x))];
    let memberId = r.memberId;
    let personId = r.personId;
    if (r.action === 'create') {
      memberId = await insertMember(tx, actor, { ...person, preferredChannel: 'email', joinDate: d(row.joinDate)!, applicationDate: null, groupIds: groups, membershipNumber: row.membershipNumber }, today, 'member.imported', runId);
      personId = (await tx.selectFrom('member').select('person_id').where('id', '=', memberId).executeTakeFirstOrThrow()).person_id;
    } else {
      // Updates fill in what the file has; empty cells never erase existing data. Old values go to the audit log.
      const before = (await tx.selectFrom('person').selectAll().where('id', '=', personId!).forUpdate().executeTakeFirstOrThrow()) as unknown as Record<string, unknown>;
      const next: Record<string, string | null> = { first_name: person.firstName, last_name: person.lastName, company_name: person.companyName, birth_date: person.birthDate, email: person.email, phone: person.phone, street: person.street, postal_code: person.postalCode, city: person.city, note: person.note, ...(row.country ? { country: person.country } : {}) };
      const set = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== null && v !== before[k]));
      if (Object.keys(set).length) {
        await tx.updateTable('person').set({ ...set, updated_at: new Date() }).where('id', '=', personId!).execute();
        await audit(tx, actor.organizationId, actor, { action: 'member.updated', entityType: 'member', entityId: memberId!, diff: { ...Object.fromEntries(Object.entries(set).map(([k, v]) => [k, [before[k] ?? null, v]])), source: [null, `import ${runId}`] } });
      }
      // Members who already left get no new group memberships; overlapping ones are not duplicated.
      for (const g of left ? [] : groups) {
        const overlap = await tx.selectFrom('group_membership').select('id').where('member_id', '=', memberId!).where('group_id', '=', g).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', today)])).executeTakeFirst();
        if (!overlap) await tx.insertInto('group_membership').values({ organization_id: actor.organizationId, member_id: memberId!, group_id: g, valid_from: today, import_run_id: runId }).execute();
      }
    }
    if (exitDate) {
      const done = await tx.updateTable('member').set({ status: left ? 'former' : 'resigned', exit_date: exitDate, notice_date: left ? exitDate : today, updated_at: new Date() }).where('id', '=', memberId!).where('status', 'in', ['active', 'future']).executeTakeFirst();
      if (Number(done.numUpdatedRows)) await tx.updateTable('group_membership').set({ valid_to: exitDate }).where('member_id', '=', memberId!).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', exitDate)])).where('valid_from', '<=', exitDate).execute();
    }
    if (row.iban && row.mandateDate) {
      const iban = normalizeIban(row.iban);
      const own = await tx.selectFrom('sepa_mandate').select(['id', 'iban_hash', 'reference']).where('person_id', '=', personId!).where('status', 'in', ['active', 'pending_evidence']).executeTakeFirst();
      const foreignRef = row.mandateReference ? await tx.selectFrom('sepa_mandate').select('person_id').where('organization_id', '=', actor.organizationId).where('reference', '=', row.mandateReference).executeTakeFirst() : undefined;
      if (left) notes.push('Ausgetreten: Das Mandat wird nicht übernommen.');
      else if (own && own.iban_hash === blindIndex(iban)) {
        // Already there: nothing to do.
      } else if (own) notes.push(`Hat schon ein Mandat (${own.reference}); es wird nicht ersetzt.`);
      else if (foreignRef && foreignRef.person_id !== personId) notes.push(`Mandatsreferenz ${row.mandateReference} gehört schon jemand anderem; Mandat nicht übernommen.`);
      else if (!foreignRef) {
        // Signed mandates from the old system stay valid; the creditor ID and reference are kept, so debits continue as recurring.
        const number = (await tx.selectFrom('member').select('membership_number').where('id', '=', memberId!).executeTakeFirstOrThrow()).membership_number;
        const m = await insertMandate(tx, actor, { personId: personId!, memberId: memberId!, membershipNumber: number, today, reference: row.mandateReference, signedOn: d(row.mandateDate)!, accountHolder: row.accountHolder || [row.firstName, row.lastName].filter(Boolean).join(' ') || row.companyName || 'Kontoinhaber', iban, bic: row.bic ?? null, type: 'recurrent', pendingEvidence: false });
        await tx.updateTable('sepa_mandate').set({ import_run_id: runId, first_collected: true }).where('id', '=', m.id).execute();
        await tx.updateTable('member').set({ payment_method: 'direct_debit' }).where('id', '=', memberId!).execute();
      }
    }
    return notes;
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
      await sql`select pg_advisory_xact_lock(hashtext(${`import:${actor.organizationId}`}))`.execute(tx);
      const run = await tx.selectFrom('import_run').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!run) throw notFound('Import');
      if (run.rolled_back_at) throw new Problem(409, 'rolled-back', 'Dieser Import ist schon rückgängig gemacht.');
      const members = tx.selectFrom('member').select('id').where('import_run_id', '=', run.id);
      const persons = tx.selectFrom('person').select('id').where('import_run_id', '=', run.id);
      const groupsOfRun = tx.selectFrom('club_group').select('id').where('import_run_id', '=', run.id);
      // Name what depends on the imported records. Anything this list misses still fails safely (foreign key → 409).
      const blockers: [string, () => Promise<unknown>][] = [
        ['Rechnungen', () => tx.selectFrom('invoice').select('id').where((eb) => eb.or([eb('recipient_person_id', 'in', persons), eb('member_id', 'in', members)])).executeTakeFirst()],
        ['Beitragszuordnungen', () => tx.selectFrom('fee_assignment').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['Abrechnungen', () => tx.selectFrom('assessment').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['Lastschriften', () => tx.selectFrom('collection_item').select('id').where('mandate_id', 'in', tx.selectFrom('sepa_mandate').select('id').where('person_id', 'in', persons)).executeTakeFirst()],
        ['später erfasste Mandate', () => tx.selectFrom('sepa_mandate').select('id').where('person_id', 'in', persons).where((eb) => eb.or([eb('import_run_id', 'is', null), eb('import_run_id', '!=', run.id)])).executeTakeFirst()],
        ['später erfasste Gruppenmitgliedschaften', () => tx.selectFrom('group_membership').select('id').where((eb) => eb.or([eb('member_id', 'in', members), eb('group_id', 'in', groupsOfRun)])).where((eb) => eb.or([eb('import_run_id', 'is', null), eb('import_run_id', '!=', run.id)])).executeTakeFirst()],
        ['Untergruppen der neuen Gruppen', () => tx.selectFrom('club_group').select('id').where('parent_id', 'in', groupsOfRun).executeTakeFirst()],
        ['Beitragsläufe der neuen Gruppen', () => tx.selectFrom('fee_run').select('id').where('group_id', 'in', groupsOfRun).executeTakeFirst()],
        ['Haushalte', () => tx.selectFrom('household').select('id').where('payer_person_id', 'in', persons).executeTakeFirst()],
        ['Terminrückmeldungen', () => tx.selectFrom('participation').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['E-Mails', () => tx.selectFrom('delivery').select('id').where('person_id', 'in', persons).executeTakeFirst()],
        ['Dateien', () => tx.selectFrom('file').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['Änderungswünsche', () => tx.selectFrom('change_request').select('id').where('member_id', 'in', members).executeTakeFirst()],
        ['Aufnahmeanträge', () => tx.selectFrom('application').select('id').where('member_id', 'in', members).executeTakeFirst()],
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

/** Short code for a new group from its letters, unique within the club (admins can rename). */
function shortCode(name: string, taken: Set<string>) {
  const letters = name.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'GRP';
  for (let n = 1; ; n++) {
    const code = n === 1 ? letters : `${letters}${n}`;
    if (!taken.has(code)) {
      taken.add(code);
      return code;
    }
  }
}
