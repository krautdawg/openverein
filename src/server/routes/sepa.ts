import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { candidate, mandate, mandateCreate, run, runCreate, runSummary, type Candidate } from '../../shared/sepa.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { blindIndex, decrypt, encrypt, maskIban } from '../crypto.ts';
import type { SepaMandateTable } from '../db.ts';
import { CONSTRAINT_MESSAGES, notFound, Problem } from '../http/problem.ts';
import { loadMemberRow, orgToday, scopePredicate } from '../members/query.ts';
import { can, requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';
import { isValidCreditorId } from '../../shared/iban.ts';
import { addBusinessDays, isTargetDay, pain001, pain008, splitIntoFiles } from '../sepa/pain.ts';
import { addDays } from '../../shared/dates.ts';
import { validateSepa } from '../sepa/validate.ts';
import type { Selectable } from 'kysely';

CONSTRAINT_MESSAGES.sepa_mandate_organization_id_reference_key = 'Diese Mandatsreferenz ist schon vergeben.';
CONSTRAINT_MESSAGES.collection_item_invoice_live = 'Mindestens eine Rechnung ist bereits in einem anderen Einzug. Doppelte Abbuchung verhindert.';

const idParam = z.object({ id: z.uuid() });
const tags = ['sepa'];

export const sepaRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  function mandateDto(actor: Actor, m: Selectable<SepaMandateTable>) {
    const showIban = can(actor, 'sepa', 'read') && !restrictedFields(actor).has('iban');
    const iban = decrypt(m.iban_encrypted);
    return {
      id: m.id,
      personId: m.person_id,
      reference: m.reference,
      signedOn: m.signed_on,
      accountHolder: m.account_holder,
      ibanMasked: maskIban(iban),
      ...(showIban ? { iban } : {}),
      bic: m.bic,
      type: m.type,
      status: m.status,
      lastCollectedOn: m.last_collected_on,
      revokedOn: m.revoked_on,
      revokeReason: m.revoke_reason,
    };
  }

  // ---------- Mandates ----------

  /** A mandate in a file that is generated, downloaded or submitted will still be debited. */
  async function assertMandateNotLive(mandateId: string) {
    const live = await db
      .selectFrom('collection_item')
      .innerJoin('collection_run', 'collection_run.id', 'collection_item.run_id')
      .select('collection_item.id')
      .where('collection_item.mandate_id', '=', mandateId)
      .where('collection_item.status', '=', 'included')
      .where('collection_run.status', 'in', ['generated', 'downloaded', 'submitted'])
      .executeTakeFirst();
    if (live) throw new Problem(409, 'mandate-in-run', 'Mit diesem Mandat läuft gerade ein Einzug.', 'Gib den Einzug zuerst frei oder warte die Gutschrift ab.');
  }

  app.get('/members/:id/mandates', { schema: { tags, summary: 'SEPA-Mandate des Mitglieds (Kontoinhaber:in ist die Person des Mitglieds)', params: idParam, response: { 200: z.array(mandate) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'sepa', 'read');
    const { row } = await loadMemberRow(db, actor, req.params.id, 'read', 'sepa');
    const rows = await db.selectFrom('sepa_mandate').selectAll().where('person_id', '=', row.person_id).orderBy('created_at', 'desc').execute();
    return rows.map((m) => mandateDto(actor, m));
  });

  app.post('/members/:id/mandates', { schema: { tags, summary: 'SEPA-Mandat erfassen (ersetzt ein aktives Mandat)', params: idParam, body: mandateCreate, response: { 201: mandate } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'sepa', 'write');
    if (restrictedFields(actor).has('iban')) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Du darfst keine IBAN sehen oder erfassen.', { permission: 'members.field.iban' });
    const { row, today } = await loadMemberRow(db, actor, req.params.id, 'write', 'sepa');
    if (req.body.signedOn > today) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'signedOn', message: 'Das Datum liegt in der Zukunft.' }] });
    const old = await db.selectFrom('sepa_mandate').select('id').where('person_id', '=', row.person_id).where('status', 'in', ['active', 'pending_evidence']).execute();
    for (const o of old) await assertMandateNotLive(o.id);
    const m = await db.transaction().execute(async (tx) => {
      const count = await tx.selectFrom('sepa_mandate').select(sql<number>`count(*)::int`.as('n')).where('person_id', '=', row.person_id).executeTakeFirstOrThrow();
      const reference = req.body.reference ?? `${row.membership_number}-${count.n + 1}`.replace(/[^A-Za-z0-9/?:().,'+ -]/g, '-').slice(0, 35);
      // One active mandate per person: a new one replaces the old.
      await tx.updateTable('sepa_mandate').set({ status: 'revoked', revoked_on: today, revoke_reason: 'Durch neues Mandat ersetzt', updated_at: new Date() }).where('person_id', '=', row.person_id).where('status', 'in', ['active', 'pending_evidence']).execute();
      const m = await tx
        .insertInto('sepa_mandate')
        .values({
          organization_id: actor.organizationId,
          person_id: row.person_id,
          reference,
          signed_on: req.body.signedOn,
          account_holder: req.body.accountHolder,
          iban_encrypted: encrypt(req.body.iban),
          iban_hash: blindIndex(req.body.iban),
          iban_last4: req.body.iban.slice(-4),
          bic: req.body.bic ?? null,
          type: req.body.type,
          status: req.body.pendingEvidence ? 'pending_evidence' : 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'mandate.created', entityType: 'member', entityId: row.id, diff: { reference: [null, reference], iban: ['•••', '•••'] } });
      return m;
    });
    reply.status(201);
    return mandateDto(actor, m);
  });

  async function changeMandate(actor: Actor, id: string, change: (m: Selectable<SepaMandateTable>, today: string) => Record<string, unknown>, action: string) {
    requirePermission(actor, 'sepa', 'write');
    return db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom('sepa_mandate').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!m) throw notFound('Mandat');
      const member = await tx.selectFrom('member').select('id').where('person_id', '=', m.person_id).executeTakeFirst();
      if (member) await loadMemberRow(tx, actor, member.id, 'write', 'sepa');
      const today = await orgToday(tx, actor.organizationId);
      const values = change(m, today);
      const after = await tx.updateTable('sepa_mandate').set({ ...values, updated_at: new Date() }).where('id', '=', m.id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action, entityType: 'member', entityId: member?.id ?? null, diff: { reference: [m.reference, m.reference], status: [m.status, after.status] } });
      return mandateDto(actor, after);
    });
  }

  app.post('/mandates/:id/revoke', { schema: { tags, summary: 'Mandat widerrufen', params: idParam, body: z.object({ reason: z.string().trim().min(2).max(200), on: z.iso.date().optional() }), response: { 200: mandate } } }, async (req) => {
    const actor = requireActor(req);
    await assertMandateNotLive(req.params.id);
    return changeMandate(actor, req.params.id, (m, today) => {
      if (m.status === 'revoked') throw new Problem(409, 'already-revoked', 'Das Mandat ist bereits widerrufen.');
      return { status: 'revoked', revoked_on: req.body.on ?? today, revoke_reason: req.body.reason };
    }, 'mandate.revoked');
  });

  app.post('/mandates/:id/activate', { schema: { tags, summary: 'Unterschriebenes Mandat liegt vor: aktivieren', params: idParam, body: z.object({}).optional(), response: { 200: mandate } } }, async (req) => {
    const actor = requireActor(req);
    return changeMandate(actor, req.params.id, (m) => {
      if (m.status !== 'pending_evidence') throw new Problem(409, 'not-pending', 'Nur Mandate ohne Unterschrift lassen sich aktivieren.');
      return { status: 'active' };
    }, 'mandate.activated');
  });

  // ---------- Collection runs ----------

  /** Open receivables (debit) or open credit notes (transfer) with whether they can go into a run. */
  async function candidates(actor: Actor, kind: 'debit' | 'transfer'): Promise<Candidate[]> {
    const today = await orgToday(db, actor.organizationId);
    let q = db
      .selectFrom('invoice')
      .innerJoin('member', 'member.id', 'invoice.member_id')
      .leftJoin('sepa_mandate as m', (j) => j.onRef('m.person_id', '=', 'invoice.recipient_person_id').on('m.status', '=', 'active'))
      .select(['invoice.id', 'invoice.number', 'invoice.kind', 'invoice.due_date', 'invoice.total_cents', 'invoice.paid_cents', 'invoice.member_id', 'invoice.recipient', 'member.payment_method', 'm.reference', 'm.type as mandate_type', 'm.first_collected'])
      .select((eb) => eb.exists(eb.selectFrom('collection_item_invoice as c').select('c.id').whereRef('c.invoice_id', '=', 'invoice.id').where('c.live', '=', true)).as('in_run'))
      .where('invoice.organization_id', '=', actor.organizationId)
      .where('invoice.status', 'in', ['open', 'partially_paid'])
      .where('invoice.kind', 'in', kind === 'debit' ? ['membership', 'other', 'dunning_fee'] : ['credit_note']);
    const scope = scopeOf(actor, 'sepa', 'write');
    if (scope !== null) q = q.where(scopePredicate(scope, today, 'write'));
    const rows = await q.orderBy('invoice.due_date').execute();
    return rows.map((r) => {
      const snap = r.recipient as { recipient: { name: string }; mandateReference?: string | null };
      let readiness: Candidate['readiness'];
      if (r.in_run) readiness = 'in_run';
      else if (kind === 'debit' && r.payment_method !== 'direct_debit') readiness = 'not_debit';
      else if (!r.reference || (kind === 'debit' && r.mandate_type === 'one_off' && r.first_collected)) readiness = kind === 'debit' ? 'no_mandate' : 'no_iban';
      // The invoice is the pre-notification: it must have announced exactly this mandate.
      else if (kind === 'debit' && snap.mandateReference !== r.reference) readiness = 'no_prenotification';
      else readiness = 'ok';
      return {
      invoiceId: r.id,
      number: r.number!,
      recipientName: snap.recipient.name,
      memberId: r.member_id,
      dueDate: r.due_date,
      openCents: r.total_cents - r.paid_cents,
      kind: r.kind,
      mandateReference: r.reference,
      readiness,
    };
    });
  }

  app.get('/collection-runs/candidates', { schema: { tags, summary: 'Offene Posten mit Einzugsbereitschaft', querystring: z.object({ kind: z.enum(['debit', 'transfer']).default('debit') }), response: { 200: z.array(candidate) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'sepa', 'read');
    return candidates(actor, req.query.kind);
  });

  /** Collection runs span the whole club: only unscoped grants may see or act on them. */
  function requireClubWide(actor: Actor, level: 'read' | 'write') {
    requirePermission(actor, 'sepa', level);
    if (scopeOf(actor, 'sepa', level) !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Einzüge sind nur für Zugänge für den ganzen Verein.', { permission: `sepa:${level} (ganzer Verein)` });
  }

  async function runDto(actor: Actor, id: string) {
    const r = await db.selectFrom('collection_run').innerJoin('bank_account', 'bank_account.id', 'collection_run.bank_account_id').selectAll('collection_run').select('bank_account.name as account_name').where('collection_run.id', '=', id).where('collection_run.organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!r) throw notFound('Einzug');
    const files = await db.selectFrom('collection_file').selectAll().where('run_id', '=', r.id).orderBy('position').execute();
    const items = await db
      .selectFrom('collection_item')
      .innerJoin('person', 'person.id', 'collection_item.person_id')
      .leftJoin('sepa_mandate', 'sepa_mandate.id', 'collection_item.mandate_id')
      .select(['collection_item.id', 'collection_item.end_to_end_id', 'collection_item.amount_cents', 'collection_item.status', 'person.first_name', 'person.last_name', 'person.company_name', 'sepa_mandate.reference'])
      .select((eb) => eb.selectFrom('collection_item_invoice as c').innerJoin('invoice', 'invoice.id', 'c.invoice_id').select(sql<string[]>`array_agg(invoice.number order by invoice.number)`.as('n')).whereRef('c.item_id', '=', 'collection_item.id').as('numbers'))
      .where('collection_item.run_id', '=', r.id)
      .orderBy('person.last_name')
      .execute();
    return {
      id: r.id,
      kind: r.kind,
      bankAccountId: r.bank_account_id,
      bankAccountName: r.account_name,
      collectionDate: r.collection_date,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      itemCount: items.filter((i) => i.status !== 'withdrawn').length,
      totalCents: items.filter((i) => i.status !== 'withdrawn').reduce((s, i) => s + i.amount_cents, 0),
      files: files.map((f) => ({ position: f.position, messageId: f.message_id, sequenceType: f.sequence_type, itemCount: f.item_count, controlSumCents: f.control_sum_cents, sha256: f.sha256, downloadedAt: f.first_downloaded_at?.toISOString() ?? null })),
      items: items.map((i) => ({ id: i.id, endToEndId: i.end_to_end_id, name: i.company_name ?? [i.first_name, i.last_name].filter(Boolean).join(' '), amountCents: i.amount_cents, status: i.status, invoiceNumbers: i.numbers ?? [], mandateReference: i.reference })),
    };
  }

  app.get('/collection-runs', { schema: { tags, summary: 'Lastschrifteinzüge und Überweisungsläufe', response: { 200: z.array(runSummary) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'read');
    const ids = await db.selectFrom('collection_run').select('id').where('organization_id', '=', actor.organizationId).orderBy('created_at', 'desc').limit(50).execute();
    return Promise.all(ids.map(async ({ id }) => {
      const { items: _i, files: _f, ...rest } = await runDto(actor, id);
      return rest;
    }));
  });

  app.get('/collection-runs/:id', { schema: { tags, summary: 'Einzug mit Dateien und Positionen', params: idParam, response: { 200: run } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'read');
    return runDto(actor, req.params.id);
  });

  app.post(
    '/collection-runs',
    { schema: { tags, summary: 'Einzug anlegen und SEPA-Datei erzeugen (XSD-geprüft). Jede Rechnung kann nur in einem laufenden Einzug sein.', body: runCreate, response: { 201: run } } },
    async (req, reply) => {
      const actor = requireActor(req);
      requireClubWide(actor, 'write');
      if (restrictedFields(actor).has('iban')) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Die SEPA-Datei enthält IBANs, die Du nicht sehen darfst.', { permission: 'members.field.iban' });
      const today = await orgToday(db, actor.organizationId);
      const { kind, bankAccountId, collectionDate, invoiceIds } = req.body;
      const org = await db.selectFrom('organization').select(['name', 'creditor_id']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
      const account = await db.selectFrom('bank_account').selectAll().where('id', '=', bankAccountId).where('organization_id', '=', actor.organizationId).where('archived_at', 'is', null).executeTakeFirst();
      if (!account) throw notFound('Bankkonto');
      const field = (message: string) => new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', message, { errors: [{ field: 'collectionDate', message }] });
      if (kind === 'debit') {
        if (!org.creditor_id || !isValidCreditorId(org.creditor_id)) throw new Problem(400, 'no-creditor-id', 'Für Lastschriften braucht der Verein eine gültige Gläubiger-ID.', 'Trage sie unter Einstellungen → Verein ein.');
        if (!isTargetDay(collectionDate)) throw field('Das Einzugsdatum ist kein Bankarbeitstag (TARGET2).');
        const earliest = addBusinessDays(today, account.min_lead_days);
        if (collectionDate < earliest) throw field(`Frühestens ${earliest.split('-').reverse().join('.')} (${account.min_lead_days} Bankarbeitstage Vorlauf).`);
      } else if (collectionDate < today) {
        throw field('Das Ausführungsdatum liegt in der Vergangenheit.');
      }
      const all = new Map((await candidates(actor, kind)).map((c) => [c.invoiceId, c]));
      const chosen = invoiceIds.map((id) => all.get(id));
      const notReady = chosen.filter((c) => !c || c.readiness !== 'ok');
      if (notReady.length) throw new Problem(409, 'not-ready', `${notReady.length} der gewählten Rechnungen können nicht eingezogen werden.`, 'Lade die Liste neu und wähle nur Rechnungen mit Status „Bereit“.');
      // Pre-notification: the invoice announced the due date, so we never collect before it.
      const early = chosen.filter((c) => kind === 'debit' && c!.dueDate && c!.dueDate > collectionDate);
      if (early.length) throw field(`${early.length} Rechnungen sind erst nach dem Einzugsdatum fällig (Vorabankündigung). Wähle ein späteres Datum.`);
      if (kind === 'debit') {
        const days = (await db.selectFrom('organization').select('prenotification_days').where('id', '=', actor.organizationId).executeTakeFirstOrThrow()).prenotification_days;
        const issued = await db.selectFrom('invoice').select(['number', 'issue_date']).where('id', 'in', invoiceIds).execute();
        const tooSoon = issued.filter((i) => i.issue_date && addDays(i.issue_date, days) > collectionDate);
        if (tooSoon.length) throw field(`${tooSoon.length} Rechnungen wurden vor weniger als ${days} Tagen angekündigt (Vorabankündigungsfrist). Wähle ein späteres Datum.`);
      }

      const id = await db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('collection_run').values({ organization_id: actor.organizationId, kind, bank_account_id: account.id, collection_date: collectionDate, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
        const seq = r.id.replace(/-/g, '').slice(-10);
        const items: { itemId: string; e2e: string; amountCents: number; mandate: Selectable<SepaMandateTable>; remittance: string; name: string }[] = [];
        let n = 0;
        for (const c of chosen as Candidate[]) {
          const inv = await tx.selectFrom('invoice').select(['recipient_person_id', 'total_cents', 'paid_cents', 'status']).where('id', '=', c.invoiceId).forUpdate().executeTakeFirstOrThrow();
          if (!['open', 'partially_paid'].includes(inv.status)) throw new Problem(409, 'not-open', `Rechnung ${c.number} ist nicht mehr offen.`);
          const m = await tx.selectFrom('sepa_mandate').selectAll().where('person_id', '=', inv.recipient_person_id).where('status', '=', 'active').forUpdate().executeTakeFirst();
          if (!m) throw new Problem(409, 'no-mandate', `Für Rechnung ${c.number} gibt es kein aktives Mandat mehr.`);
          if (kind === 'debit' && m.type === 'one_off' && items.some((x) => x.mandate.id === m.id)) throw new Problem(409, 'one-off', `Das Einmal-Mandat ${m.reference} kann nur einmal eingezogen werden.`);
          const amount = inv.total_cents - inv.paid_cents;
          const e2e = `OV${seq}${String(++n).padStart(5, '0')}`;
          const item = await tx
            .insertInto('collection_item')
            .values({ organization_id: actor.organizationId, run_id: r.id, mandate_id: m.id, person_id: inv.recipient_person_id, end_to_end_id: e2e, amount_cents: amount, sequence_type: kind === 'debit' ? (m.type === 'one_off' ? 'OOFF' : 'RCUR') : null })
            .returning('id')
            .executeTakeFirstOrThrow();
          // The partial unique index refuses a second live item for the same invoice (double-debit guard).
          await tx.insertInto('collection_item_invoice').values({ organization_id: actor.organizationId, item_id: item.id, invoice_id: c.invoiceId, amount_cents: amount }).execute();
          items.push({ itemId: item.id, e2e, amountCents: amount, mandate: m, remittance: `${kind === 'debit' ? 'Lastschrift' : 'Erstattung'} ${c.number} ${org.name}`, name: c.recipientName });
        }

        // Files: grouped by sequence type, split by 999 items and the bank's order limit.
        const groups = new Map<string, typeof items>();
        for (const it of items) {
          const st = kind === 'debit' ? (it.mandate.type === 'one_off' ? 'OOFF' : 'RCUR') : 'TRF';
          groups.set(st, [...(groups.get(st) ?? []), it]);
        }
        let position = 0;
        const createdAt = new Date().toISOString().slice(0, 19);
        for (const [st, list] of groups) {
          let chunks: (typeof items)[];
          try {
            chunks = splitIntoFiles(list, account.order_limit_cents);
          } catch {
            throw new Problem(409, 'order-limit', 'Eine einzelne Lastschrift ist höher als das Auftragslimit des Kontos.');
          }
          for (const chunk of chunks) {
            position++;
            const messageId = `OV-${seq}-${position}`;
            const xml = kind === 'debit'
              ? pain008({
                  messageId, createdAt, creditor: { name: org.name, iban: account.iban, bic: account.bic }, creditorId: org.creditor_id!, collectionDate, sequenceType: st as 'RCUR' | 'OOFF', batchBooking: true,
                  items: chunk.map((it) => ({ endToEndId: it.e2e, amountCents: it.amountCents, mandateId: it.mandate.reference, mandateSignedOn: it.mandate.signed_on, debtorName: it.mandate.account_holder, debtorIban: decrypt(it.mandate.iban_encrypted), debtorBic: it.mandate.bic, remittance: it.remittance, originalIban: it.mandate.amendment_pending && it.mandate.amended_from_iban_encrypted ? decrypt(it.mandate.amended_from_iban_encrypted) : null })),
                })
              : pain001({
                  messageId, createdAt, debtor: { name: org.name, iban: account.iban, bic: account.bic }, executionDate: collectionDate, batchBooking: true,
                  items: chunk.map((it) => ({ endToEndId: it.e2e, amountCents: it.amountCents, creditorName: it.mandate.account_holder, creditorIban: decrypt(it.mandate.iban_encrypted), creditorBic: it.mandate.bic, remittance: it.remittance })),
                });
            try {
              validateSepa(xml, kind === 'debit' ? 'pain.008.001.08' : 'pain.001.001.09');
            } catch (err) {
              // No details in the log: libxml2 messages can contain IBANs.
              req.log.error({ schemaError: (err as Error).name }, 'generated SEPA file failed XSD validation');
              throw new Problem(500, 'xsd', 'Die erzeugte SEPA-Datei hat die Schema-Prüfung nicht bestanden. Es wurde nichts gespeichert.');
            }
            const file = await tx
              .insertInto('collection_file')
              .values({ organization_id: actor.organizationId, run_id: r.id, position, message_id: messageId, schema: kind === 'debit' ? 'pain.008.001.08' : 'pain.001.001.09', sequence_type: kind === 'debit' ? st : null, xml_encrypted: encrypt(xml), sha256: createHash('sha256').update(xml).digest('hex'), item_count: chunk.length, control_sum_cents: chunk.reduce((s, it) => s + it.amountCents, 0) })
              .returning('id')
              .executeTakeFirstOrThrow();
            await tx.updateTable('collection_item').set({ file_id: file.id }).where('id', 'in', chunk.map((c) => c.itemId)).execute();
          }
        }
        if (kind === 'debit') {
          await tx.updateTable('sepa_mandate').set({ last_collected_on: collectionDate, first_collected: true }).where('id', 'in', [...new Set(items.map((i) => i.mandate.id))]).execute();
          // The amendment travels with this run; if the run is released, it goes back to the mandate.
          const amended = items.filter((i) => i.mandate.amendment_pending);
          if (amended.length) {
            await tx.updateTable('collection_item').set({ carries_amendment: true }).where('id', 'in', amended.map((i) => i.itemId)).execute();
            await tx.updateTable('sepa_mandate').set({ amendment_pending: false }).where('id', 'in', amended.map((i) => i.mandate.id)).execute();
          }
        }
        await tx.updateTable('collection_run').set({ status: 'generated', generated_at: new Date() }).where('id', '=', r.id).execute();
        await audit(tx, actor.organizationId, actor, { action: 'collection_run.generated', entityType: 'collection_run', entityId: r.id, diff: { kind: [null, kind], items: [null, items.length], totalCents: [null, items.reduce((s, i) => s + i.amountCents, 0)] } });
        return r.id;
      });
      reply.status(201);
      return runDto(actor, id);
    },
  );

  app.get('/collection-runs/:id/files/:position', { schema: { tags, summary: 'SEPA-Datei herunterladen (immer dieselben Bytes; der erste Download markiert den Einzug als heruntergeladen)', params: z.object({ id: z.uuid(), position: z.coerce.number().int().min(1) }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'write');
    if (restrictedFields(actor).has('iban')) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Die SEPA-Datei enthält IBANs, die Du nicht sehen darfst.', { permission: 'members.field.iban' });
    // The download changes state (the run becomes live); a link on a foreign site must not trigger it.
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new Problem(403, 'cross-origin', 'Anfragen von fremden Seiten werden abgelehnt.');
    const f = await db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('collection_run').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Einzug');
      if (r.status === 'released') throw new Problem(409, 'released', 'Dieser Einzug wurde freigegeben; die Datei darf nicht mehr eingereicht werden.');
      const f = await tx.selectFrom('collection_file').selectAll().where('run_id', '=', r.id).where('position', '=', req.params.position).executeTakeFirst();
      if (!f) throw notFound('Datei');
      if (!f.first_downloaded_at) await tx.updateTable('collection_file').set({ first_downloaded_at: new Date() }).where('id', '=', f.id).execute();
      // From the first download on, the run counts as live: it may already be at the bank.
      if (r.status === 'generated') await tx.updateTable('collection_run').set({ status: 'downloaded' }).where('id', '=', r.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'collection_run.downloaded', entityType: 'collection_run', entityId: r.id, diff: { file: [null, f.message_id] } });
      return f;
    });
    reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${f.message_id}.xml"`);
    return decrypt(f.xml_encrypted);
  });

  app.post('/collection-runs/:id/submitted', { schema: { tags, summary: 'Vermerken, dass die Datei bei der Bank eingereicht wurde', params: idParam, body: z.object({}).optional(), response: { 200: run } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'write');
    await db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('collection_run').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Einzug');
      if (!['generated', 'downloaded'].includes(r.status)) throw new Problem(409, 'wrong-status', 'Das geht in diesem Status nicht.');
      await tx.updateTable('collection_run').set({ status: 'submitted', submitted_at: new Date() }).where('id', '=', r.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'collection_run.submitted', entityType: 'collection_run', entityId: r.id });
    });
    return runDto(actor, req.params.id);
  });

  app.post(
    '/collection-runs/:id/release',
    {
      schema: {
        tags,
        summary: 'Einzug freigeben: Rechnungen werden wieder einziehbar. Nach dem Download nur mit der Bestätigung, dass die Datei nie eingereicht wurde.',
        params: idParam,
        body: z.object({ reason: z.string().trim().min(3).max(300), confirmNotSubmitted: z.boolean().default(false) }),
        response: { 200: run },
      },
    },
    async (req) => {
      const actor = requireActor(req);
      requireClubWide(actor, 'write');
      await db.transaction().execute(async (tx) => {
        const r = await tx.selectFrom('collection_run').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
        if (!r) throw notFound('Einzug');
        if (['released', 'settled'].includes(r.status)) throw new Problem(409, 'wrong-status', 'Dieser Einzug ist abgeschlossen.');
        if (['downloaded', 'submitted'].includes(r.status) && !req.body.confirmNotSubmitted) {
          throw new Problem(409, 'confirm-required', 'Die Datei wurde schon heruntergeladen.', 'Bestätige, dass sie nie bei der Bank eingereicht wurde (und gelöscht ist), sonst droht eine doppelte Abbuchung.');
        }
        const settled = await tx.selectFrom('collection_item').select('id').where('run_id', '=', r.id).where('status', '=', 'settled').executeTakeFirst();
        if (settled) throw new Problem(409, 'has-settled', 'Für diesen Einzug sind schon Gutschriften gebucht. Er kann nicht freigegeben werden.');
        await tx.updateTable('collection_item').set({ status: 'withdrawn' }).where('run_id', '=', r.id).where('status', '=', 'included').execute();
        await tx.updateTable('collection_item_invoice').set({ live: false }).where('item_id', 'in', tx.selectFrom('collection_item').select('id').where('run_id', '=', r.id)).execute();
        await tx.updateTable('collection_run').set({ status: 'released', released_at: new Date(), release_reason: req.body.reason }).where('id', '=', r.id).execute();
        // A released run never reached the bank: the mandates' last use comes from the remaining runs again.
        await sql`update sepa_mandate m set
            last_collected_on = (select max(cr.collection_date) from collection_item ci join collection_run cr on cr.id = ci.run_id where ci.mandate_id = m.id and cr.kind = 'debit' and cr.status <> 'released'),
            first_collected = exists (select 1 from collection_item ci join collection_run cr on cr.id = ci.run_id where ci.mandate_id = m.id and cr.kind = 'debit' and cr.status <> 'released')
          where m.id in (select mandate_id from collection_item where run_id = ${r.id} and mandate_id is not null)`.execute(tx);
        await sql`update sepa_mandate set amendment_pending = true
          where id in (select mandate_id from collection_item where run_id = ${r.id} and carries_amendment)`.execute(tx);
        await audit(tx, actor.organizationId, actor, { action: 'collection_run.released', entityType: 'collection_run', entityId: r.id, diff: { status: [r.status, 'released'], reason: [null, req.body.reason], confirmedNotSubmitted: [null, req.body.confirmNotSubmitted] } });
      });
      return runDto(actor, req.params.id);
    },
  );
};
