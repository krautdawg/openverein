import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { allocateInput, bankAccount, bankAccountInput, bankBookInput, bankTx, importInput, importResult } from '../../shared/sepa.ts';
import { bookingLines, lockJournal, postEntry, reverseEntry } from '../ledger/service.ts';
import { orgToday } from '../members/query.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { parseCamt053, type BankTx as ParsedTx } from '../banking/camt.ts';
import { parseBankCsv } from '../banking/csv.ts';
import { autoMatch, invoiceNumberRegex, processReturn, suggestionsFor } from '../banking/matching.ts';
import { blindIndex, decrypt, encrypt, maskIban } from '../crypto.ts';
import { CONSTRAINT_MESSAGES, notFound, Problem } from '../http/problem.ts';
import { refreshPayment } from '../invoices/service.ts';
import { requireClubWide, requirePermission, scopeOf, type Actor } from '../policy.ts';
import { assertNotLive } from '../sepa/live.ts';

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
    // The IBAN is the account's identity in statements and SEPA files: a different account is a new bank account.
    if (b.iban !== undefined) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'iban', message: 'Die IBAN eines Kontos ändert sich nicht. Leg für ein anderes Konto ein neues Bankkonto an.' }] });
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
        // One import or rollback per account at a time: a rollback must not delete a booking a concurrent import skipped as a duplicate.
        await tx.selectFrom('bank_account').select('id').where('id', '=', account.id).forUpdate().execute();
        const imp = await tx
          .insertInto('bank_statement_import')
          .values({ organization_id: actor.organizationId, bank_account_id: account.id, format: req.body.format, file_name: req.body.fileName ?? null, file_sha256: sha, period_from: parsed.from, period_to: parsed.to, opening_cents: parsed.opening, closing_cents: parsed.closing, raw_encrypted: encrypt(req.body.content), created_by: actor.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        let imported = 0;
        let duplicates = 0;
        const skippedSamples: string[] = [];
        const ids: string[] = [];
        const seen = new Map<string, number>();
        for (const t of parsed.transactions) {
          // Overlapping statements: the same booking twice has the same fingerprint and is skipped. The running
          // number within the file keeps real repeats (two equal transfers on one day) apart.
          const base = [t.bookingDate, t.amountCents, t.counterpartyIban ?? '', t.remittance, t.endToEndId ?? '', t.bankReference ?? ''].join('|');
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          const dedupe = createHash('sha256').update(`${base}|${n}`).digest('hex');
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
          } else {
            duplicates++;
            if (skippedSamples.length < 5) skippedSamples.push(`${t.bookingDate.split('-').reverse().join('.')} ${(t.amountCents / 100).toFixed(2).replace('.', ',')} € ${t.counterpartyName ?? ''}`.trim());
          }
        }
        // A CSV file has no balances to catch a wrongly skipped movement: name what was taken for a duplicate.
        if (duplicates && req.body.format === 'csv') warnings.push(`${duplicates} Bewegungen sahen aus wie schon eingelesene und wurden übersprungen (${skippedSamples.join('; ')}${duplicates > skippedSamples.length ? '; …' : ''}). Ist eine davon eine neue Zahlung, erfasse sie von Hand.`);
        await tx.updateTable('bank_statement_import').set({ transaction_count: imported }).where('id', '=', imp.id).execute();
        // Balance check: opening balance + every booking must equal the statement's closing balance.
        if (parsed.closing !== null) {
          const sum = await tx.selectFrom('bank_transaction').select(sql<number>`coalesce(sum(amount_cents), 0)::bigint`.as('s')).where('bank_account_id', '=', account.id).executeTakeFirstOrThrow();
          const balance = account.openingBalanceCents + Number(sum.s);
          if (balance !== parsed.closing) {
            const msg = `Der Saldo laut Auszug (${(parsed.closing / 100).toFixed(2)} €) weicht vom Saldo in OpenVerein (${(balance / 100).toFixed(2)} €) ab.`;
            if (!req.body.balanceOverrideReason) throw new Problem(409, 'balance-mismatch', msg, 'Prüfe Anfangssaldo und fehlende Auszüge, oder importiere mit Begründung trotzdem.', { closingCents: parsed.closing, balanceCents: balance });
            warnings.push(`${msg} Trotzdem eingelesen: ${req.body.balanceOverrideReason}`);
          }
        }
        await audit(tx, actor.organizationId, actor, { action: 'bank_import.created', entityType: 'bank_account', entityId: account.id, diff: { imported: [null, imported], duplicates: [null, duplicates] } });
        return { id: imp.id, imported, duplicates, ids };
      });
      // The import is committed; a failing match must not report it as failed (a retry would hit the duplicate-file check).
      let matched = { matched: 0, returns: 0 };
      try {
        matched = await autoMatch(db, actor.organizationId, actor, result.ids);
      } catch (err) {
        req.log.error(err, 'automatic matching after import failed');
        warnings.push('Der automatische Abgleich ist fehlgeschlagen. Starte ihn unter Bank → Abgleich mit „Automatisch abgleichen“ erneut.');
      }
      reply.status(201);
      return { id: result.id, imported: result.imported, duplicates: result.duplicates, autoMatched: matched.matched, returns: matched.returns, warnings };
    },
  );

  app.delete('/bank-imports/:id', { schema: { tags, summary: 'Import zurückrollen, solange nichts davon zugeordnet ist', params: idParam, body: z.object({}).optional(), response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    await db.transaction().execute(async (tx) => {
      const found = await tx.selectFrom('bank_statement_import').select(['bank_account_id']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!found) throw notFound('Import');
      // Same lock order as an import: account first, then the import.
      await tx.selectFrom('bank_account').select('id').where('id', '=', found.bank_account_id).forUpdate().execute();
      const imp = await tx.selectFrom('bank_statement_import').select(['id', 'bank_account_id']).where('id', '=', req.params.id).forUpdate().executeTakeFirstOrThrow();
      // Only the latest import of an account: a later, overlapping import may have skipped these bookings as duplicates.
      const later = await tx.selectFrom('bank_statement_import').select('id').where('bank_account_id', '=', imp.bank_account_id).where(sql<boolean>`(created_at, id) > (select created_at, id from bank_statement_import where id = ${imp.id})`).executeTakeFirst();
      if (later) throw new Problem(409, 'not-latest', 'Nur der zuletzt eingelesene Auszug lässt sich zurückrollen.');
      const used = await tx.selectFrom('bank_transaction').select('id').where('import_id', '=', imp.id).where('status', '<>', 'unmatched').executeTakeFirst();
      // Reversed allocations still point at the bookings, so they count as "used" too.
      const touched = await tx.selectFrom('allocation').innerJoin('bank_transaction', 'bank_transaction.id', 'allocation.bank_transaction_id').select('allocation.id').where('bank_transaction.import_id', '=', imp.id).executeTakeFirst();
      if (used || touched) throw new Problem(409, 'in-use', 'Buchungen aus diesem Import wurden schon zugeordnet. Der Auszug bleibt deshalb stehen.');
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
    const entryIds = rows.map((r) => r.journal_entry_id).filter((x): x is string => !!x);
    const entries = new Map(entryIds.length ? (await db.selectFrom('journal_entry').select(['id', 'number']).where('id', 'in', entryIds).execute()).map((e) => [e.id, Number(e.number)]) : []);
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
      journalNumber: t.journal_entry_id ? (entries.get(t.journal_entry_id) ?? null) : null,
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
    { schema: { tags, summary: 'Kontobewegungen; status=unmatched ist der Abgleich-Eingang mit Vorschlägen', querystring: z.object({ bankAccountId: z.uuid().optional(), status: z.enum(['unmatched', 'matched', 'ignored', 'booked', 'all']).default('unmatched'), limit: z.coerce.number().int().min(1).max(200).default(100) }), response: { 200: z.array(bankTx) } } },
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
        await assertNotLive(tx, inv.id);
        await tx.insertInto('allocation').values({ organization_id: actor.organizationId, invoice_id: inv.id, amount_cents: a.amountCents, booked_on: t.booking_date, method: 'transfer', bank_transaction_id: t.id, created_by: actor.userId }).execute();
        await refreshPayment(tx, inv.id);
      }
      await tx.updateTable('bank_transaction').set({ status: 'matched' }).where('id', '=', t.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'bank_transaction.allocated', entityType: 'bank_transaction', entityId: t.id, diff: { allocations: [null, req.body.allocations] } });
    });
    return (await txDto(actor, [await loadTx(actor, req.params.id)]))[0]!;
  });

  app.post('/bank-transactions/book', { schema: { tags, summary: 'Mehrere Kontobewegungen ohne Rechnung auf ein Konto buchen (Sphäre, Kostenstelle, Steuersatz gemeinsam)', body: bankBookInput, response: { 200: z.object({ booked: z.number() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireBanking(actor, 'write');
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const booked = await db.transaction().execute(async (tx) => {
      await lockJournal(tx, actor.organizationId);
      const rows = await tx.selectFrom('bank_transaction').innerJoin('bank_account', 'bank_account.id', 'bank_transaction.bank_account_id')
        .select(['bank_transaction.id', 'bank_transaction.booking_date', 'bank_transaction.amount_cents', 'bank_transaction.counterparty_name', 'bank_transaction.remittance', 'bank_transaction.status', 'bank_account.ledger_account_id', 'bank_account.name as bank_name'])
        .where('bank_transaction.organization_id', '=', actor.organizationId).where('bank_transaction.id', 'in', b.transactionIds).orderBy('bank_transaction.booking_date').forUpdate().execute();
      if (rows.length !== new Set(b.transactionIds).size || rows.some((r) => r.status !== 'unmatched')) throw new Problem(409, 'not-open', 'Nicht alle gewählten Bewegungen sind noch offen.', 'Lade die Liste neu und wähle noch einmal.');
      // Like payments on invoices: the bank account's own ledger account, else the default bank account.
      const fallback = (await tx.selectFrom('ledger_setting').select('bank_account_id').where('organization_id', '=', actor.organizationId).executeTakeFirst())?.bank_account_id ?? null;
      const noAccount = rows.find((r) => !(r.ledger_account_id ?? fallback));
      if (noAccount) throw new Problem(409, 'bank-ledger-account', `Das Bankkonto ${noAccount.bank_name} hat kein Buchhaltungskonto.`, 'Ordne es unter Buchhaltung → Einstellungen zu.');
      if (rows.some((r) => r.amount_cents > 0) && rows.some((r) => r.amount_cents < 0)) throw new Problem(400, 'mixed-directions', 'Einnahmen und Ausgaben bitte getrennt buchen.');
      // Like manual bookings: nothing dated after today (a reversal today would precede it).
      const today = await orgToday(tx, actor.organizationId);
      if (rows.some((r) => String(r.booking_date) > today)) throw new Problem(409, 'future-date', 'Eine gewählte Bewegung liegt in der Zukunft.', 'Buche sie an ihrem Buchungstag.');
      const kind = rows[0]!.amount_cents > 0 ? 'income' : 'expense';
      for (const r of rows) {
        const text = [r.counterparty_name, r.remittance].filter(Boolean).join(': ').slice(0, 300) || 'Kontobewegung';
        const { lines } = await bookingLines(tx, actor.organizationId, { kind, date: r.booking_date, moneyAccountId: r.ledger_account_id ?? fallback, lines: [{ grossCents: Math.abs(r.amount_cents), accountId: b.accountId, sphere: b.sphere, costCenterId: b.costCenterId, taxRateId: b.taxRateId }] });
        const e = await postEntry(tx, actor.organizationId, { date: r.booking_date, text, source: 'manual', createdBy: actor.userId, lines });
        await tx.updateTable('bank_transaction').set({ status: 'booked', journal_entry_id: e.id }).where('id', '=', r.id).execute();
      }
      await audit(tx, actor.organizationId, actor, { action: 'bank_transaction.booked', entityType: 'ledger_account', entityId: b.accountId, diff: { transactions: [null, rows.length], sphere: [null, b.sphere ?? null] } });
      return rows.length;
    });
    return { booked };
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
    await db.transaction().execute(async (tx) => {
      const t = await tx.selectFrom('bank_transaction').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!t) throw notFound('Buchung');
      // The right that made the state undoes it: a booking needs the ledger, a match the invoices, an ignore nothing more.
      if (t.status !== 'booked' && t.status !== 'ignored') requirePermission(actor, 'invoices', 'write');
      const ret = await tx.selectFrom('return_debit').select('id').where('bank_transaction_id', '=', t.id).executeTakeFirst();
      if (ret) throw new Problem(409, 'is-return', 'Eine verbuchte Rücklastschrift lässt sich nicht aufheben. Ziehe die Rechnung erneut ein oder buche sie aus.');
      const lock = (await tx.selectFrom('ledger_setting').select('lock_date').where('organization_id', '=', actor.organizationId).executeTakeFirst())?.lock_date;
      if (lock && t.booking_date <= lock) throw new Problem(409, 'period-locked', 'Diese Kontobewegung liegt in einem abgeschlossenen Zeitraum.', 'Die Zuordnung lässt sich danach nicht neu setzen. Korrigiere bei der Rechnung (Zahlung zurücknehmen und neu erfassen) oder öffne den Zeitraum wieder.');
      if (t.status === 'booked') {
        requireClubWide(actor, 'ledger', 'write');
        await lockJournal(tx, actor.organizationId);
        // Unlink first (the booking check), then reverse: the original entry stays, its counter-entry is dated today.
        await tx.updateTable('bank_transaction').set({ status: 'unmatched', note: null, journal_entry_id: null }).where('id', '=', t.id).execute();
        await reverseEntry(tx, actor.organizationId, t.journal_entry_id!, await orgToday(tx, actor.organizationId), actor.userId);
        await audit(tx, actor.organizationId, actor, { action: 'bank_transaction.unbooked', entityType: 'bank_transaction', entityId: t.id });
        return;
      }
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
        const item = await tx
          .selectFrom('collection_item')
          .innerJoin('collection_run', 'collection_run.id', 'collection_item.run_id')
          .select(['collection_item.id', 'collection_item.status'])
          .where('collection_item.organization_id', '=', actor.organizationId)
          .where('collection_item.end_to_end_id', '=', req.body.endToEndId)
          .where('collection_run.kind', '=', 'debit')
          .executeTakeFirst();
        if (!item || !['included', 'settled'].includes(item.status)) throw new Problem(404, 'not-found', 'Keine passende Lastschrift-Position gefunden.');
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
