import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { account, accountInput, accountPatch, bookingInput, costCenter, euerReport, journalEntry, ledgerSettings, SPHERES, taxRate, wirtschaftLimitCents } from '../../shared/ledger.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { assertCashNotNegative, bookingLines, lockJournal, postEntry, reverseEntry, syncAllocations, unpostedPayments } from '../ledger/service.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide, requireStepUp } from '../policy.ts';

const tags = ['ledger'];
const idParam = z.object({ id: z.uuid() });
const rangeBase = z.object({ from: z.iso.date(), to: z.iso.date() });
const sane = (r: { from: string; to: string }) => r.from <= r.to && Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4)) <= 10;
const range = rangeBase.refine(sane, { message: 'Zeitraum: Anfang vor Ende, höchstens zehn Jahre.' });

export const ledgerRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function settingsOf(organizationId: string) {
    await sql`select ov_seed_ledger(${organizationId}::uuid)`.execute(db);
    return db.selectFrom('ledger_setting').selectAll().where('organization_id', '=', organizationId).executeTakeFirstOrThrow();
  }
  async function accountsOf(q: Db, organizationId: string) {
    return q.selectFrom('ledger_account').selectAll().where('organization_id', '=', organizationId).orderBy('number').execute();
  }

  // ---------- Chart of accounts ----------

  app.get('/ledger/accounts', { schema: { tags, summary: 'Kontenplan', response: { 200: z.array(account) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    await settingsOf(actor.organizationId);
    const used = new Set((await db.selectFrom('journal_line').select('account_id').distinct().where('organization_id', '=', actor.organizationId).execute()).map((r) => r.account_id));
    return (await accountsOf(db, actor.organizationId)).map((a) => ({ id: a.id, number: a.number, name: a.name, kind: a.kind, defaultSphere: a.default_sphere, datevNumber: a.datev_number, hidden: a.hidden, retired: !!a.retired_at, used: used.has(a.id) }));
  });

  app.post('/ledger/accounts', { schema: { tags, summary: 'Konto anlegen', body: accountInput, response: { 201: account } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const a = await db.transaction().execute(async (tx) => {
      const a = await tx.insertInto('ledger_account').values({ organization_id: actor.organizationId, number: b.number, name: b.name, kind: b.kind, default_sphere: b.defaultSphere, datev_number: b.datevNumber ?? null }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'ledger.account_created', entityType: 'ledger_account', entityId: a.id, diff: { number: [null, a.number], name: [null, a.name] } });
      return a;
    });
    reply.status(201);
    return { id: a.id, number: a.number, name: a.name, kind: a.kind, defaultSphere: a.default_sphere, datevNumber: a.datev_number, hidden: a.hidden, retired: false, used: false };
  });

  app.patch('/ledger/accounts/:id', { schema: { tags, summary: 'Konto ändern, ausblenden oder stilllegen (benutzte Konten werden nie gelöscht)', params: idParam, body: accountPatch, response: { 200: account } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const a = await db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('ledger_account').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Konto');
      const a = await tx
        .updateTable('ledger_account')
        .set({ ...(b.name ? { name: b.name } : {}), ...(b.defaultSphere ? { default_sphere: b.defaultSphere } : {}), ...(b.datevNumber !== undefined ? { datev_number: b.datevNumber } : {}), ...(b.hidden !== undefined ? { hidden: b.hidden } : {}), ...(b.retired !== undefined ? { retired_at: b.retired ? new Date() : null } : {}) })
        .where('id', '=', before.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'ledger.account_updated', entityType: 'ledger_account', entityId: a.id, diff: { name: [before.name, a.name], datev: [before.datev_number, a.datev_number], retired: [!!before.retired_at, !!a.retired_at] } });
      return a;
    });
    const used = !!(await db.selectFrom('journal_line').select('id').where('account_id', '=', a.id).executeTakeFirst());
    return { id: a.id, number: a.number, name: a.name, kind: a.kind, defaultSphere: a.default_sphere, datevNumber: a.datev_number, hidden: a.hidden, retired: !!a.retired_at, used };
  });

  app.get('/ledger/tax-rates', { schema: { tags, summary: 'Steuersätze (mit Gültigkeit)', response: { 200: z.array(taxRate) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    await settingsOf(actor.organizationId);
    return (await db.selectFrom('tax_rate').selectAll().where('organization_id', '=', actor.organizationId).orderBy('valid_from', 'desc').execute()).map((t) => ({ id: t.id, label: t.label, rateBp: t.rate_bp, validFrom: t.valid_from, validTo: t.valid_to }));
  });

  app.get('/ledger/cost-centers', { schema: { tags, summary: 'Kostenstellen', response: { 200: z.array(costCenter) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    return db.selectFrom('cost_center').select(['id', 'code', 'name']).where('organization_id', '=', actor.organizationId).orderBy('code').execute();
  });

  app.post('/ledger/cost-centers', { schema: { tags, summary: 'Kostenstelle anlegen', body: z.object({ code: z.string().trim().regex(/^[0-9A-Za-z-]{1,12}$/, 'Bis 12 Zeichen: Buchstaben, Ziffern, Bindestrich.'), name: z.string().trim().min(1).max(120) }), response: { 201: costCenter } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const c = await db.insertInto('cost_center').values({ organization_id: actor.organizationId, ...req.body }).returning(['id', 'code', 'name']).executeTakeFirstOrThrow();
    await audit(db, actor.organizationId, actor, { action: 'ledger.cost_center_created', entityType: 'cost_center', entityId: c.id });
    reply.status(201);
    return c;
  });

  // ---------- Settings and lock date ----------

  async function settingsDto(organizationId: string) {
    const s = await settingsOf(organizationId);
    const banks = await db.selectFrom('bank_account').select(['id', 'name', 'iban', 'ledger_account_id']).where('organization_id', '=', organizationId).where('archived_at', 'is', null).orderBy('name').execute();
    return { bankAccountId: s.bank_account_id, cashAccountId: s.cash_account_id, feeAccountId: s.fee_account_id, otherIncomeAccountId: s.other_income_account_id, dunningAccountId: s.dunning_account_id, lockDate: s.lock_date, bankAccounts: banks.map((b) => ({ id: b.id, name: b.name, ibanLast4: b.iban.slice(-4), ledgerAccountId: b.ledger_account_id })) };
  }

  app.get('/ledger/settings', { schema: { tags, summary: 'Buchhaltungs-Einstellungen: Zuordnung der Zahlungen, Sperrdatum', response: { 200: ledgerSettings } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    return settingsDto(actor.organizationId);
  });

  const accountRef = z.uuid().nullable().optional();
  app.patch(
    '/ledger/settings',
    { schema: { tags, summary: 'Zuordnung ändern: auf welche Konten Zahlungen gebucht werden', body: z.object({ bankAccountId: accountRef, cashAccountId: accountRef, feeAccountId: accountRef, otherIncomeAccountId: accountRef, dunningAccountId: accountRef, bankAccounts: z.array(z.object({ id: z.uuid(), ledgerAccountId: z.uuid().nullable() })).optional() }), response: { 200: ledgerSettings } } },
    async (req) => {
      const actor = requireActor(req);
      requireClubWide(actor, 'ledger', 'write');
      await settingsOf(actor.organizationId);
      const accounts = await accountsOf(db, actor.organizationId);
      const b = req.body;
      const check = (id: string | null | undefined, kinds: string[], field: string) => {
        if (!id) return;
        const a = accounts.find((x) => x.id === id);
        if (!a || !kinds.includes(a.kind)) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field, message: 'Dieses Konto passt hier nicht.' }] });
      };
      check(b.bankAccountId, ['money'], 'bankAccountId');
      check(b.cashAccountId, ['money'], 'cashAccountId');
      for (const f of ['feeAccountId', 'otherIncomeAccountId', 'dunningAccountId'] as const) check(b[f], ['income'], f);
      for (const x of b.bankAccounts ?? []) check(x.ledgerAccountId, ['money'], 'bankAccounts');
      await db.transaction().execute(async (tx) => {
        const map = { bankAccountId: 'bank_account_id', cashAccountId: 'cash_account_id', feeAccountId: 'fee_account_id', otherIncomeAccountId: 'other_income_account_id', dunningAccountId: 'dunning_account_id' } as const;
        const set = Object.fromEntries(Object.entries(map).filter(([k]) => b[k as keyof typeof map] !== undefined).map(([k, col]) => [col, b[k as keyof typeof map] ?? null]));
        if (Object.keys(set).length) await tx.updateTable('ledger_setting').set(set).where('organization_id', '=', actor.organizationId).execute();
        for (const x of b.bankAccounts ?? []) await tx.updateTable('bank_account').set({ ledger_account_id: x.ledgerAccountId }).where('id', '=', x.id).where('organization_id', '=', actor.organizationId).execute();
        await audit(tx, actor.organizationId, actor, { action: 'ledger.settings_updated', entityType: 'organization', entityId: actor.organizationId, diff: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, [null, v]])) });
      });
      return settingsDto(actor.organizationId);
    },
  );

  app.post(
    '/ledger/lock',
    { schema: { tags, summary: 'Sperrdatum setzen (GoBD): danach keine Buchung und keine Zahlung mit früherem Datum. Zurücksetzen nur mit Bestätigung und Begründung.', body: z.object({ lockDate: z.iso.date().nullable(), reason: z.string().trim().max(300).optional() }), response: { 200: ledgerSettings } } },
    async (req) => {
      const actor = requireActor(req);
      requireClubWide(actor, 'ledger', 'write');
      const before = await settingsOf(actor.organizationId);
      const today = await orgToday(db, actor.organizationId);
      const next = req.body.lockDate;
      if (next && next >= today) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'lockDate', message: 'Nur vergangene Tage lassen sich sperren.' }] });
      const backwards = !!before.lock_date && (!next || next < before.lock_date);
      if (backwards) {
        requireStepUp(actor);
        if (!req.body.reason || req.body.reason.length < 5) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'reason', message: 'Bitte begründe, warum ein abgeschlossener Zeitraum wieder geöffnet wird.' }] });
      }
      // Post everything that belongs before the lock while it is still open.
      await syncAllocations(db, actor.organizationId);
      await db.transaction().execute(async (tx) => {
        await lockJournal(tx, actor.organizationId);
        // Row lock: payments being inserted right now (their trigger reads this row) finish first, later ones see the new date.
        const current = await tx.selectFrom('ledger_setting').select('lock_date').where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirstOrThrow();
        if (next && (!current.lock_date || next > current.lock_date)) {
          const n = await unpostedPayments(tx, actor.organizationId, current.lock_date, next);
          if (n) throw new Problem(409, 'unposted-payments', `${n} Zahlung${n === 1 ? '' : 'en'} bis zu diesem Tag ${n === 1 ? 'ist' : 'sind'} noch nicht gebucht.`, 'Ordne unter Buchhaltung → Einstellungen allen Zahlungsarten ein Konto zu und versuche es noch einmal.');
        }
        await tx.updateTable('ledger_setting').set({ lock_date: next }).where('organization_id', '=', actor.organizationId).execute();
        await audit(tx, actor.organizationId, actor, { action: backwards ? 'ledger.lock_moved_back' : 'ledger.locked', entityType: 'organization', entityId: actor.organizationId, diff: { lockDate: [before.lock_date, next], reason: [null, req.body.reason ?? null] } });
      });
      return settingsDto(actor.organizationId);
    },
  );

  // ---------- Journal ----------

  async function entriesDto(organizationId: string, ids: string[]) {
    if (!ids.length) return [];
    const entries = await db.selectFrom('journal_entry').leftJoin('app_user', 'app_user.id', 'journal_entry.created_by').selectAll('journal_entry').select('app_user.name as user').where('journal_entry.id', 'in', ids).orderBy('journal_entry.entry_date', 'desc').orderBy('journal_entry.number', 'desc').execute();
    const lines = await db
      .selectFrom('journal_line')
      .innerJoin('ledger_account', 'ledger_account.id', 'journal_line.account_id')
      .leftJoin('cost_center', 'cost_center.id', 'journal_line.cost_center_id')
      .leftJoin('tax_rate', 'tax_rate.id', 'journal_line.tax_rate_id')
      .select(['journal_line.entry_id', 'journal_line.account_id', 'ledger_account.number', 'ledger_account.name', 'journal_line.debit_cents', 'journal_line.credit_cents', 'journal_line.sphere', 'cost_center.code as cc', 'tax_rate.label as rate', 'journal_line.text'])
      .where('journal_line.entry_id', 'in', ids)
      .orderBy('journal_line.debit_cents', 'desc')
      .execute();
    const reversals = await db.selectFrom('journal_entry').select(['number', 'reverses_id']).where('organization_id', '=', organizationId).where('reverses_id', 'in', ids).execute();
    const numbers = new Map((await db.selectFrom('journal_entry').select(['id', 'number']).where('id', 'in', entries.map((e) => e.reverses_id).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000'])).execute()).map((e) => [e.id, e.number]));
    return entries.map((e) => ({
      id: e.id,
      number: e.number,
      date: e.entry_date,
      text: e.text,
      source: e.source,
      reversesNumber: e.reverses_id ? (numbers.get(e.reverses_id) ?? null) : null,
      reversedBy: reversals.find((r) => r.reverses_id === e.id)?.number ?? null,
      createdBy: e.user,
      createdAt: e.created_at.toISOString(),
      lines: lines.filter((l) => l.entry_id === e.id).map((l) => ({ accountId: l.account_id, accountNumber: l.number, accountName: l.name, debitCents: Number(l.debit_cents), creditCents: Number(l.credit_cents), sphere: l.sphere, costCenter: l.cc, taxRate: l.rate, text: l.text })),
    }));
  }

  app.get('/ledger/entries', { schema: { tags, summary: 'Journal (Zahlungen werden vorher automatisch gebucht)', querystring: rangeBase.extend({ accountId: z.uuid().optional() }).refine(sane, { message: 'Zeitraum: Anfang vor Ende, höchstens zehn Jahre.' }), response: { 200: z.array(journalEntry) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    await syncAllocations(db, actor.organizationId);
    let q = db.selectFrom('journal_entry').select('journal_entry.id').where('journal_entry.organization_id', '=', actor.organizationId).where('journal_entry.entry_date', '>=', req.query.from).where('journal_entry.entry_date', '<=', req.query.to);
    if (req.query.accountId) q = q.where((eb) => eb.exists(eb.selectFrom('journal_line').select('journal_line.id').whereRef('journal_line.entry_id', '=', 'journal_entry.id').where('journal_line.account_id', '=', req.query.accountId!)));
    const ids = (await q.orderBy('journal_entry.entry_date', 'desc').orderBy('journal_entry.number', 'desc').limit(1000).execute()).map((r) => r.id);
    return entriesDto(actor.organizationId, ids);
  });

  app.post('/ledger/bookings', { schema: { tags, summary: 'Einnahme, Ausgabe oder Umbuchung zwischen eigenen Konten buchen (auch mit mehreren Steuersätzen)', body: bookingInput, response: { 201: journalEntry } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const settings = await settingsOf(actor.organizationId);
    const today = await orgToday(db, actor.organizationId);
    if (b.date > today) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'date', message: 'Das Datum liegt in der Zukunft.' }] });
    const id = await db.transaction().execute(async (tx) => {
      // Cash checks and numbering under one lock, so two cash expenses cannot both pass.
      await lockJournal(tx, actor.organizationId);
      if (b.kind === 'transfer') {
        const accounts = await accountsOf(tx, actor.organizationId);
        const from = accounts.find((a) => a.id === b.fromAccountId && a.kind === 'money');
        const to = accounts.find((a) => a.id === b.toAccountId && a.kind === 'money');
        const transit = accounts.find((a) => a.kind === 'transit');
        if (!from || !to || from.id === to.id || !transit) throw new Problem(400, 'validation', 'Bitte zwei verschiedene Geldkonten wählen.');
        if (from.id === settings.cash_account_id) await assertCashNotNegative(tx, actor.organizationId, from.id, b.date, -b.amountCents);
        const e = await postEntry(tx, actor.organizationId, {
          date: b.date, text: b.text, source: 'manual', createdBy: actor.userId,
          lines: [
            { accountId: transit.id, debitCents: b.amountCents, sphere: 'ideell' },
            { accountId: from.id, creditCents: b.amountCents, sphere: 'ideell' },
            { accountId: to.id, debitCents: b.amountCents, sphere: 'ideell' },
            { accountId: transit.id, creditCents: b.amountCents, sphere: 'ideell' },
          ],
        });
        await audit(tx, actor.organizationId, actor, { action: 'ledger.transfer', entityType: 'journal_entry', entityId: e.id, diff: { amountCents: [null, b.amountCents] } });
        return e.id;
      }
      const { lines, money, total } = await bookingLines(tx, actor.organizationId, b);
      if (b.kind === 'expense' && money.id === settings.cash_account_id) await assertCashNotNegative(tx, actor.organizationId, money.id, b.date, -total);
      const e = await postEntry(tx, actor.organizationId, { date: b.date, text: b.text, source: 'manual', createdBy: actor.userId, lines });
      await audit(tx, actor.organizationId, actor, { action: `ledger.${b.kind}`, entityType: 'journal_entry', entityId: e.id, diff: { totalCents: [null, total] } });
      return e.id;
    });
    reply.status(201);
    return (await entriesDto(actor.organizationId, [id]))[0]!;
  });

  app.post('/ledger/entries/:id/reverse', { schema: { tags, summary: 'Buchung stornieren (Gegenbuchung; das Original bleibt unverändert)', params: idParam, body: z.object({ date: z.iso.date().optional() }).optional(), response: { 201: journalEntry } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const today = await orgToday(db, actor.organizationId);
    const original = await db.selectFrom('journal_entry').select(['source', 'entry_date']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!original) throw notFound('Buchung');
    // Payments are corrected where they happen (reverse the payment); their postings follow automatically.
    if (original.source === 'allocation' || original.source === 'allocation_reversal') throw new Problem(409, 'payment-entry', 'Diese Buchung kommt aus einer Zahlung.', 'Nimm die Zahlung bei der Rechnung oder im Kontoabgleich zurück; die Buchung folgt automatisch.');
    if (original.source === 'donation') throw new Problem(409, 'donation-entry', 'Diese Buchung gehört zu einer Spende.', 'Mach die Spende unter Spenden ungültig; die Buchung wird dabei storniert.');
    const date = req.body?.date ?? today;
    if (date < original.entry_date) throw new Problem(400, 'validation', 'Das Storno kann nicht vor der Buchung liegen.');
    if (date > today) throw new Problem(400, 'validation', 'Das Storno kann nicht in der Zukunft liegen.');
    const e = await db.transaction().execute(async (tx) => {
      const e = await reverseEntry(tx, actor.organizationId, req.params.id, date, actor.userId);
      await audit(tx, actor.organizationId, actor, { action: 'ledger.reversed', entityType: 'journal_entry', entityId: req.params.id, diff: { reversal: [null, e.number] } });
      return e;
    });
    reply.status(201);
    return (await entriesDto(actor.organizationId, [e.id]))[0]!;
  });

  // ---------- Reports ----------

  async function warnings(organizationId: string, from: string, to: string) {
    const out: { kind: string; message: string; href: string | null }[] = [];
    const open = await db.selectFrom('bank_transaction').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', organizationId).where('status', '=', 'unmatched').where('booking_date', '>=', from).where('booking_date', '<=', to).executeTakeFirstOrThrow();
    if (open.n) out.push({ kind: 'unmatched', message: `${open.n} Kontobewegung${open.n === 1 ? '' : 'en'} im Zeitraum noch nicht zugeordnet: Die EÜR ist unvollständig.`, href: '/bank/abgleich' });
    const unmapped = await db.selectFrom('ledger_account').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', organizationId).where('datev_number', 'is', null).where((eb) => eb.exists(eb.selectFrom('journal_line').select('journal_line.id').whereRef('journal_line.account_id', '=', 'ledger_account.id'))).executeTakeFirstOrThrow();
    if (unmapped.n) out.push({ kind: 'datev', message: `${unmapped.n} benutzte${unmapped.n === 1 ? 's Konto hat' : ' Konten haben'} noch keine DATEV-Nummer.`, href: '/buchhaltung/konten' });
    // Economic sphere: gross income (net plus output VAT) per calendar year against the § 64 AO limit.
    const w = await sql<{ y: number; gross: number }>`
      select extract(year from e.entry_date)::int as y, coalesce(sum(l.credit_cents - l.debit_cents), 0)::bigint as gross
      from journal_line l join journal_entry e on e.id = l.entry_id join ledger_account a on a.id = l.account_id
      where l.organization_id = ${organizationId} and l.sphere = 'wirtschaft' and e.entry_date between ${from}::date and ${to}::date
        and (a.kind = 'income' or a.id in (select output_account_id from tax_rate where organization_id = ${organizationId}))
      group by 1 order by 1`.execute(db);
    for (const { y, gross: g } of w.rows) {
      const gross = Number(g);
      const limit = wirtschaftLimitCents(y);
      const label = (limit / 100).toLocaleString('de-DE') + ' €';
      if (gross > limit) out.push({ kind: 'limit', message: `Wirtschaftlicher Geschäftsbetrieb ${y}: Einnahmen über ${label} (Besteuerungsgrenze nach § 64 AO). Sprich mit Deiner Steuerberatung.`, href: null });
      else if (gross >= limit * 0.8) out.push({ kind: 'limit-near', message: `Wirtschaftlicher Geschäftsbetrieb ${y}: Einnahmen bei ${Math.round((gross / limit) * 100)} % der Besteuerungsgrenze von ${label}.`, href: null });
    }
    return out;
  }

  app.get('/ledger/reports/euer', { schema: { tags, summary: 'Einnahmen-Überschuss-Rechnung nach Sphären (netto, mit Umsatzsteuer und Vorsteuer)', querystring: range, response: { 200: euerReport } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    await syncAllocations(db, actor.organizationId);
    const { from, to } = req.query;
    const rows = await sql<{ account_id: string; number: string; name: string; kind: 'income' | 'expense' | 'tax'; sphere: (typeof SPHERES)[number]; credit: number; debit: number }>`
      select a.id as account_id, a.number, a.name, a.kind, l.sphere, sum(l.credit_cents)::bigint as credit, sum(l.debit_cents)::bigint as debit
      from journal_line l join journal_entry e on e.id = l.entry_id join ledger_account a on a.id = l.account_id
      where l.organization_id = ${actor.organizationId} and e.entry_date between ${from}::date and ${to}::date and a.kind in ('income', 'expense', 'tax')
      group by a.id, a.number, a.name, a.kind, l.sphere order by a.number, l.sphere`.execute(db);
    const out = rows.rows.filter((r) => r.kind !== 'tax').map((r) => ({ accountId: r.account_id, number: r.number, name: r.name, kind: r.kind as 'income' | 'expense', sphere: r.sphere, netCents: r.kind === 'income' ? Number(r.credit) - Number(r.debit) : Number(r.debit) - Number(r.credit) }));
    const spheres = SPHERES.map((s) => {
      const income = out.filter((r) => r.sphere === s && r.kind === 'income').reduce((a, r) => a + r.netCents, 0);
      const expense = out.filter((r) => r.sphere === s && r.kind === 'expense').reduce((a, r) => a + r.netCents, 0);
      return { sphere: s, incomeCents: income, expenseCents: expense, resultCents: income - expense };
    });
    const rates = await db.selectFrom('tax_rate').select(['output_account_id', 'input_account_id']).where('organization_id', '=', actor.organizationId).execute();
    const outputAccounts = new Set(rates.map((r) => r.output_account_id));
    const inputAccounts = new Set(rates.map((r) => r.input_account_id));
    const tax = rows.rows.filter((r) => r.kind === 'tax');
    const net = (accounts: Set<string | null>, sign: 1 | -1) => tax.filter((r) => accounts.has(r.account_id)).reduce((a, r) => a + sign * (Number(r.credit) - Number(r.debit)), 0);
    const incomeCents = spheres.reduce((a, s) => a + s.incomeCents, 0);
    const expenseCents = spheres.reduce((a, s) => a + s.expenseCents, 0);
    return {
      from,
      to,
      rows: out,
      spheres,
      vat: { outputCents: net(outputAccounts, 1), inputCents: net(inputAccounts, -1) },
      totals: { incomeCents, expenseCents, resultCents: incomeCents - expenseCents },
      warnings: await warnings(actor.organizationId, from, to),
    };
  });

  app.get('/ledger/reports/balances', { schema: { tags, summary: 'Summen und Salden je Konto (Anfangsbestand, Soll, Haben, Endbestand)', querystring: range, response: { 200: z.array(z.object({ accountId: z.uuid(), number: z.string(), name: z.string(), kind: z.string(), openingCents: z.number(), debitCents: z.number(), creditCents: z.number(), closingCents: z.number() })) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    await syncAllocations(db, actor.organizationId);
    const { from, to } = req.query;
    const rows = await sql<{ id: string; number: string; name: string; kind: string; opening: number; debit: number; credit: number }>`
      select a.id, a.number, a.name, a.kind,
        coalesce(sum(case when e.entry_date < ${from}::date then l.debit_cents - l.credit_cents end), 0)::bigint as opening,
        coalesce(sum(case when e.entry_date between ${from}::date and ${to}::date then l.debit_cents end), 0)::bigint as debit,
        coalesce(sum(case when e.entry_date between ${from}::date and ${to}::date then l.credit_cents end), 0)::bigint as credit
      from ledger_account a left join journal_line l on l.account_id = a.id left join journal_entry e on e.id = l.entry_id and e.entry_date <= ${to}::date
      where a.organization_id = ${actor.organizationId}
      group by a.id order by a.number`.execute(db);
    return rows.rows.filter((r) => Number(r.opening) || Number(r.debit) || Number(r.credit)).map((r) => ({ accountId: r.id, number: r.number, name: r.name, kind: r.kind, openingCents: Number(r.opening), debitCents: Number(r.debit), creditCents: Number(r.credit), closingCents: Number(r.opening) + Number(r.debit) - Number(r.credit) }));
  });
};
