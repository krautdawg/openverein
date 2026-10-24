import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { allocateInput, bankAccount, bankAccountInput, bankTx, importInput, importResult } from '../../shared/sepa.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { parseCamt053, type BankTx as ParsedTx } from '../banking/camt.ts';
import { parseBankCsv } from '../banking/csv.ts';
import { autoMatch, invoiceNumberRegex, processReturn, suggestionsFor } from '../banking/matching.ts';
import { blindIndex, decrypt, encrypt, maskIban } from '../crypto.ts';
import { CONSTRAINT_MESSAGES, notFound, Problem } from '../http/problem.ts';
import { refreshPayment } from '../invoices/service.ts';
import { requirePermission, scopeOf, type Actor } from '../policy.ts';

CONSTRAINT_MESSAGES.bank_account_organization_id_iban_key = 'Ein Konto mit dieser IBAN gibt es schon.';
CONSTRAINT_MESSAGES.bank_statement_import_bank_account_id_file_sha256_key = 'Diese Datei wurde für dieses Konto schon importiert.';

const idParam = z.object({ id: z.uuid() });
const tags = ['banking'];

/** Banking is club-wide; group-scoped grants never see bank data. */
function requireBanking(actor: Actor, level: 'read' | 'write') {
  requirePermission(actor, 'banking', level);
  if (scopeOf(actor, 'banking', level) !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', undefined, { permission: `banking:${level} (ganzer Verein)` });
}

export const bankingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function accountDto(actor: Actor, id?: string) {
    let q = db
      .selectFrom('bank_account')
      .selectAll('bank_account')
      .select((eb) => [
        eb.selectFrom('bank_transaction').select(sql<number>`coalesce(sum(amount_cents), 0)::bigint`.as('s')).whereRef('bank_transaction.bank_account_id', '=', 'bank_account.id').as('movements'),
        eb.selectFrom('bank_transaction').select(sql<string>`max(booking_date)`.as('d')).whereRef('bank_transaction.bank_account_id', '=', 'bank_account.id').as('last_booking'),
        eb.selectFrom('bank_transaction').select(sql<number>`count(*)::int`.as('n')).whereRef('bank_transaction.bank_account_id', '=', 'bank_account.id').where('bank_transaction.status', '=', 'unmatched').as('unmatched'),
      ])
      .where('organization_id', '=', actor.organizationId)
      .where('archived_at', 'is', null);
    if (id) q = q.where('id', '=', id);
    const rows = await q.orderBy('name').execute();
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      iban: a.iban,
      bic: a.bic,
      openingBalanceCents: a.opening_balance_cents,
      openingDate: a.opening_date,
      minLeadDays: a.min_lead_days,
      orderLimitCents: a.order_limit_cents,
      balanceCents: a.opening_balance_cents + Number(a.movements ?? 0),
      lastBookingDate: a.last_booking,
      unmatched: a.unmatched ?? 0,
    }));
  }

  app.get('/bank-accounts', { schema: { tags, summary: 'Bankkonten mit Saldo', response: { 200: z.array(bankAccount) } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'read');
    return accountDto(actor);
  });

  app.post('/bank-accounts', { schema: { tags, summary: 'Bankkonto anlegen', body: bankAccountInput, response: { 201: bankAccount } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    const b = req.body;
    const id = await db.transaction().execute(async (tx) => {
      const a = await tx
        .insertInto('bank_account')
        .values({ organization_id: actor.organizationId, name: b.name, iban: b.iban, bic: b.bic ?? null, opening_balance_cents: b.openingBalanceCents, opening_date: b.openingDate, min_lead_days: b.minLeadDays, order_limit_cents: b.orderLimitCents ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'bank_account.created', entityType: 'bank_account', entityId: a.id, diff: { name: [null, b.name] } });
      return a.id;
    });
    reply.status(201);
    return (await accountDto(actor, id))[0]!;
  });

  app.patch('/bank-accounts/:id', { schema: { tags, summary: 'Bankkonto ändern', params: idParam, body: bankAccountInput.partial(), response: { 200: bankAccount } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    const b = req.body;
    const values: Record<string, unknown> = {};
    if (b.name !== undefined) values.name = b.name;
    if (b.bic !== undefined) values.bic = b.bic;
    if (b.minLeadDays !== undefined) values.min_lead_days = b.minLeadDays;
    if (b.orderLimitCents !== undefined) values.order_limit_cents = b.orderLimitCents;
    if (b.openingBalanceCents !== undefined) values.opening_balance_cents = b.openingBalanceCents;
    if (b.openingDate !== undefined) values.opening_date = b.openingDate;
    await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('bank_account').set(values).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw notFound('Bankkonto');
      await audit(tx, actor.organizationId, actor, { action: 'bank_account.updated', entityType: 'bank_account', entityId: req.params.id, diff: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [null, v]])) });
    });
    return (await accountDto(actor, req.params.id))[0]!;
  });

  app.post(
    '/bank-accounts/:id/imports',
    { bodyLimit: 52 * 1024 * 1024, schema: { tags, summary: 'Kontoauszug importieren (CAMT.053 oder CSV); doppelte Buchungen werden erkannt, danach automatischer Abgleich', params: idParam, body: importInput, response: { 201: importResult } } },
    async (req, reply) => {
      const actor = requireActor(req);
      requireBanking(actor, 'write');
      const account = (await accountDto(actor, req.params.id))[0];
      if (!account) throw notFound('Bankkonto');
      const warnings: string[] = [];
      let parsed: { transactions: ParsedTx[]; iban: string | null; from: string | null; to: string | null; opening: number | null; closing: number | null };
      try {
        if (req.body.format === 'camt053') {
          const stmts = parseCamt053(req.body.content);
          const mine = stmts.filter((s) => !s.iban || s.iban === account.iban);
          if (mine.length === 0) throw new Error(`Der Auszug gehört zu einem anderen Konto (${stmts[0]?.iban ?? 'unbekannt'}).`);
          parsed = {
            transactions: mine.flatMap((s) => s.transactions),
            iban: mine[0]!.iban,
            from: mine.map((s) => s.from).filter(Boolean).sort()[0] ?? null,
            to: mine.map((s) => s.to).filter(Boolean).sort().at(-1) ?? null,
            opening: mine[0]!.openingCents,
            closing: mine.at(-1)!.closingCents,
          };
        } else {
          const r = parseBankCsv(req.body.content);
          if (r.skipped) warnings.push(`${r.skipped} Zeilen ohne Datum oder Betrag übersprungen.`);
          parsed = { transactions: r.transactions, iban: null, from: null, to: null, opening: null, closing: null };
        }
      } catch (err) {
        throw new Problem(400, 'unreadable', 'Die Datei konnte nicht gelesen werden.', (err as Error).message);
      }
      const sha = createHash('sha256').update(req.body.content).digest('hex');
      const result = await db.transaction().execute(async (tx) => {
        const imp = await tx
          .insertInto('bank_statement_import')
          .values({ organization_id: actor.organizationId, bank_account_id: account.id, format: req.body.format, file_name: req.body.fileName ?? null, file_sha256: sha, period_from: parsed.from, period_to: parsed.to, opening_cents: parsed.opening, closing_cents: parsed.closing, created_by: actor.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        let imported = 0;
        let duplicates = 0;
        const ids: string[] = [];
        for (const t of parsed.transactions) {
          // Overlapping statements: the same booking twice has the same fingerprint and is skipped.
          const dedupe = createHash('sha256').update([t.bookingDate, t.amountCents, t.counterpartyIban ?? '', t.remittance, t.endToEndId ?? '', t.bankReference ?? ''].join('|')).digest('hex');
          const row = await tx
            .insertInto('bank_transaction')
            .values({
              organization_id: actor.organizationId,
              bank_account_id: account.id,
              import_id: imp.id,
              booking_date: t.bookingDate,
              value_date: t.valueDate,
              amount_cents: t.amountCents,
              counterparty_name: t.counterpartyName?.slice(0, 140) ?? null,
              counterparty_iban_encrypted: t.counterpartyIban ? encrypt(t.counterpartyIban) : null,
              counterparty_iban_hash: t.counterpartyIban ? blindIndex(t.counterpartyIban) : null,
              remittance: t.remittance.slice(0, 1000),
              end_to_end_id: t.endToEndId,
              mandate_reference: t.mandateId,
              return_reason: t.returnReason,
              bank_reference: t.bankReference,
              dedupe_key: dedupe,
            })
            .onConflict((oc) => oc.columns(['bank_account_id', 'dedupe_key']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (row) {
            imported++;
            ids.push(row.id);
          } else duplicates++;
        }
        await tx.updateTable('bank_statement_import').set({ transaction_count: imported }).where('id', '=', imp.id).execute();
        await audit(tx, actor.organizationId, actor, { action: 'bank_import.created', entityType: 'bank_account', entityId: account.id, diff: { imported: [null, imported], duplicates: [null, duplicates] } });
        return { id: imp.id, imported, duplicates, ids };
      });
      // Balance check: the statement's closing balance must equal opening balance + every booking so far.
      if (parsed.closing !== null) {
        const now = (await accountDto(actor, account.id))[0]!;
        if (now.balanceCents !== parsed.closing) warnings.push(`Der Saldo laut Auszug (${(parsed.closing / 100).toFixed(2)} €) weicht vom Saldo in OpenVerein (${(now.balanceCents / 100).toFixed(2)} €) ab. Prüfe Anfangssaldo und fehlende Auszüge.`);
      }
      const matched = await autoMatch(db, actor.organizationId, actor, result.ids);
      reply.status(201);
      return { id: result.id, imported: result.imported, duplicates: result.duplicates, autoMatched: matched.matched, returns: matched.returns, warnings };
    },
  );

  app.delete('/bank-imports/:id', { schema: { tags, summary: 'Import zurückrollen, solange nichts davon zugeordnet ist', params: idParam, body: z.object({}).optional(), response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    await db.transaction().execute(async (tx) => {
      const imp = await tx.selectFrom('bank_statement_import').select(['id', 'bank_account_id']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!imp) throw notFound('Import');
      const used = await tx.selectFrom('bank_transaction').select('id').where('import_id', '=', imp.id).where('status', '<>', 'unmatched').executeTakeFirst();
      if (used) throw new Problem(409, 'in-use', 'Buchungen aus diesem Import sind schon zugeordnet. Hebe die Zuordnung zuerst auf.');
      await tx.deleteFrom('bank_transaction').where('import_id', '=', imp.id).execute();
      await tx.deleteFrom('bank_statement_import').where('id', '=', imp.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'bank_import.rolled_back', entityType: 'bank_account', entityId: imp.bank_account_id });
    });
    reply.status(204);
    return null;
  });

  app.get('/bank-imports', { schema: { tags, summary: 'Importierte Kontoauszüge', querystring: z.object({ bankAccountId: z.uuid().optional() }), response: { 200: z.array(z.object({ id: z.uuid(), bankAccountId: z.uuid(), format: z.string(), fileName: z.string().nullable(), periodFrom: z.string().nullable(), periodTo: z.string().nullable(), transactionCount: z.number(), createdAt: z.string() })) } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'read');
    let q = db.selectFrom('bank_statement_import').selectAll().where('organization_id', '=', actor.organizationId);
    if (req.query.bankAccountId) q = q.where('bank_account_id', '=', req.query.bankAccountId);
    const rows = await q.orderBy('created_at', 'desc').limit(50).execute();
    return rows.map((r) => ({ id: r.id, bankAccountId: r.bank_account_id, format: r.format, fileName: r.file_name, periodFrom: r.period_from, periodTo: r.period_to, transactionCount: r.transaction_count, createdAt: r.created_at.toISOString() }));
  });

  async function txDto(actor: Actor, rows: Awaited<ReturnType<typeof loadTx>>[]) {
    const org = await db.selectFrom('organization').select('invoice_number_pattern').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const re = invoiceNumberRegex(org.invoice_number_pattern);
    const allocations = rows.length
      ? await db.selectFrom('allocation').innerJoin('invoice', 'invoice.id', 'allocation.invoice_id').select(['allocation.bank_transaction_id', 'allocation.invoice_id', 'invoice.number', 'allocation.amount_cents']).where('allocation.bank_transaction_id', 'in', rows.map((r) => r.id)).where('allocation.status', '=', 'confirmed').execute()
      : [];
    return Promise.all(rows.map(async (t) => ({
      id: t.id,
      bankAccountId: t.bank_account_id,
      bookingDate: t.booking_date,
      amountCents: t.amount_cents,
      counterpartyName: t.counterparty_name,
      counterpartyIbanMasked: t.counterparty_iban_encrypted ? maskIban(decrypt(t.counterparty_iban_encrypted)) : null,
      remittance: t.remittance,
      endToEndId: t.end_to_end_id,
      returnReason: t.return_reason,
      status: t.status,
      note: t.note,
      allocations: allocations.filter((a) => a.bank_transaction_id === t.id).map((a) => ({ invoiceId: a.invoice_id, number: a.number, amountCents: a.amount_cents })),
      suggestions: t.status === 'unmatched' ? await suggestionsFor(db, actor.organizationId, t, re) : [],
    })));
  }

  async function loadTx(actor: Actor, id: string) {
    const t = await db.selectFrom('bank_transaction').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!t) throw notFound('Buchung');
    return t;
  }

  app.get(
    '/bank-transactions',
    { schema: { tags, summary: 'Kontobewegungen; status=unmatched ist der Abgleich-Eingang mit Vorschlägen', querystring: z.object({ bankAccountId: z.uuid().optional(), status: z.enum(['unmatched', 'matched', 'ignored', 'all']).default('unmatched'), limit: z.coerce.number().int().min(1).max(200).default(100) }), response: { 200: z.array(bankTx) } } },
    async (req) => {
      const actor = requireActor(req);
      requireBanking(actor, 'read');
      let q = db.selectFrom('bank_transaction').selectAll().where('organization_id', '=', actor.organizationId);
      if (req.query.bankAccountId) q = q.where('bank_account_id', '=', req.query.bankAccountId);
      if (req.query.status !== 'all') q = q.where('status', '=', req.query.status);
      return txDto(actor, await q.orderBy('booking_date', 'desc').orderBy('id').limit(req.query.limit).execute());
    },
  );

  app.post('/bank-transactions/:id/allocate', { schema: { tags, summary: 'Zahlungseingang Rechnungen zuordnen (Summe muss dem Betrag entsprechen)', params: idParam, body: allocateInput, response: { 200: bankTx } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    requirePermission(actor, 'invoices', 'write');
    await db.transaction().execute(async (tx) => {
      const t = await tx.selectFrom('bank_transaction').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!t) throw notFound('Buchung');
      if (t.status !== 'unmatched') throw new Problem(409, 'not-open', 'Diese Buchung ist schon zugeordnet.');
      if (t.amount_cents <= 0) throw new Problem(400, 'not-incoming', 'Nur Zahlungseingänge lassen sich Rechnungen zuordnen.');
      const sum = req.body.allocations.reduce((s, a) => s + a.amountCents, 0);
      if (sum !== t.amount_cents) throw new Problem(400, 'sum-mismatch', 'Die Summe der Zuordnungen muss dem Betrag der Buchung entsprechen.', `Buchung ${(t.amount_cents / 100).toFixed(2)} €, zugeordnet ${(sum / 100).toFixed(2)} €.`);
      for (const a of req.body.allocations) {
        const inv = await tx.selectFrom('invoice').select(['id', 'status', 'total_cents', 'paid_cents', 'kind']).where('id', '=', a.invoiceId).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
        if (!inv || !['open', 'partially_paid'].includes(inv.status) || inv.kind === 'credit_note') throw new Problem(409, 'not-open', 'Eine der Rechnungen ist nicht offen.');
        if (a.amountCents > inv.total_cents - inv.paid_cents) throw new Problem(400, 'overpayment', 'Ein Betrag ist höher als der offene Betrag der Rechnung.');
        await tx.insertInto('allocation').values({ organization_id: actor.organizationId, invoice_id: inv.id, amount_cents: a.amountCents, booked_on: t.booking_date, method: 'transfer', bank_transaction_id: t.id, created_by: actor.userId }).execute();
        await refreshPayment(tx, inv.id);
      }
      await tx.updateTable('bank_transaction').set({ status: 'matched' }).where('id', '=', t.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'bank_transaction.allocated', entityType: 'bank_transaction', entityId: t.id, diff: { allocations: [null, req.body.allocations] } });
    });
    return (await txDto(actor, [await loadTx(actor, req.params.id)]))[0]!;
  });

  app.post('/bank-transactions/:id/ignore', { schema: { tags, summary: 'Buchung ohne Rechnung abhaken (z. B. Bankgebühr), mit Notiz', params: idParam, body: z.object({ note: z.string().trim().min(2).max(300) }), response: { 200: bankTx } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('bank_transaction').set({ status: 'ignored', note: req.body.note }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where('status', '=', 'unmatched').executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new Problem(409, 'not-open', 'Diese Buchung ist nicht offen.');
      await audit(tx, actor.organizationId, actor, { action: 'bank_transaction.ignored', entityType: 'bank_transaction', entityId: req.params.id, diff: { note: [null, req.body.note] } });
    });
    return (await txDto(actor, [await loadTx(actor, req.params.id)]))[0]!;
  });

  app.post('/bank-transactions/:id/unmatch', { schema: { tags, summary: 'Zuordnung aufheben: Zahlungen werden zurückgenommen, Einzugspositionen wieder offen', params: idParam, body: z.object({}).optional(), response: { 200: bankTx } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    requirePermission(actor, 'invoices', 'write');
    await db.transaction().execute(async (tx) => {
      const t = await tx.selectFrom('bank_transaction').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!t) throw notFound('Buchung');
      const ret = await tx.selectFrom('return_debit').select('id').where('bank_transaction_id', '=', t.id).executeTakeFirst();
      if (ret) throw new Problem(409, 'is-return', 'Eine verbuchte Rücklastschrift lässt sich nicht aufheben. Ziehe die Rechnung erneut ein oder buche sie aus.');
      const allocations = await tx.selectFrom('allocation').select(['id', 'invoice_id', 'collection_item_id']).where('bank_transaction_id', '=', t.id).where('status', '=', 'confirmed').execute();
      for (const a of allocations) {
        await tx.updateTable('allocation').set({ status: 'reversed', reversed_at: new Date() }).where('id', '=', a.id).execute();
        await refreshPayment(tx, a.invoice_id);
        if (a.collection_item_id) await tx.updateTable('collection_item').set({ status: 'included' }).where('id', '=', a.collection_item_id).where('status', '=', 'settled').execute();
      }
      await sql`update collection_run set status = 'submitted' where status = 'settled' and id in (select run_id from collection_item where id = any(${allocations.map((a) => a.collection_item_id).filter(Boolean)}::uuid[]))`.execute(tx);
      await tx.updateTable('bank_transaction').set({ status: 'unmatched', note: null }).where('id', '=', t.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'bank_transaction.unmatched', entityType: 'bank_transaction', entityId: t.id });
    });
    return (await txDto(actor, [await loadTx(actor, req.params.id)]))[0]!;
  });

  app.post(
    '/bank-transactions/:id/return',
    { schema: { tags, summary: 'Rücklastschrift von Hand einer Einzugsposition zuordnen (wenn die Bank keine Referenz liefert)', params: idParam, body: z.object({ endToEndId: z.string().trim().min(1).max(35) }), response: { 200: bankTx } } },
    async (req) => {
      const actor = requireActor(req);
      requireBanking(actor, 'write');
      requirePermission(actor, 'invoices', 'write');
      await db.transaction().execute(async (tx) => {
        const t = await tx.selectFrom('bank_transaction').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
        if (!t) throw notFound('Buchung');
        if (t.status !== 'unmatched' || t.amount_cents >= 0) throw new Problem(409, 'not-return', 'Nur offene Belastungen lassen sich als Rücklastschrift buchen.');
        const item = await tx.selectFrom('collection_item').select(['id', 'status']).where('organization_id', '=', actor.organizationId).where('end_to_end_id', '=', req.body.endToEndId).executeTakeFirst();
        if (!item || !['included', 'settled'].includes(item.status)) throw new Problem(404, 'not-found', 'Keine passende Einzugsposition gefunden.');
        await processReturn(tx, t, item.id, actor);
      });
      return (await txDto(actor, [await loadTx(actor, req.params.id)]))[0]!;
    },
  );

  app.post('/bank-transactions/match', { schema: { tags, summary: 'Automatischen Abgleich für alle offenen Buchungen erneut laufen lassen', body: z.object({}).optional(), response: { 200: z.object({ matched: z.number(), returns: z.number() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    requirePermission(actor, 'invoices', 'write');
    return autoMatch(db, actor.organizationId, actor);
  });
};
