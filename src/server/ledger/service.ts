import { sql } from 'kysely';
import type { Db, Sphere } from '../db.ts';
import { Problem } from '../http/problem.ts';
import { orgToday } from '../members/query.ts';

export interface Line {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  sphere: Sphere;
  costCenterId?: string | null;
  taxRateId?: string | null;
  text?: string | null;
}

/** Posts one balanced entry (the database checks the balance and the lock date at commit). */
export async function postEntry(
  tx: Db,
  organizationId: string,
  e: { date: string; text: string; source: 'manual' | 'allocation' | 'allocation_reversal' | 'reversal' | 'receipt' | 'import'; sourceId?: string | null; reversesId?: string | null; createdBy: string | null; lines: Line[] },
) {
  const lines = e.lines.filter((l) => (l.debitCents ?? 0) > 0 || (l.creditCents ?? 0) > 0);
  // Gapless numbers per club: one writer at a time.
  await lockJournal(tx, organizationId);
  const last = await tx.selectFrom('journal_entry').select(sql<number>`coalesce(max(number), 0)::int`.as('n')).where('organization_id', '=', organizationId).executeTakeFirstOrThrow();
  const entry = await tx
    .insertInto('journal_entry')
    .values({ organization_id: organizationId, number: last.n + 1, entry_date: e.date, text: e.text.slice(0, 300), source: e.source, source_id: e.sourceId ?? null, reverses_id: e.reversesId ?? null, created_by: e.createdBy })
    .returning(['id', 'number'])
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('journal_line')
    .values(lines.map((l) => ({ organization_id: organizationId, entry_id: entry.id, account_id: l.accountId, debit_cents: l.debitCents ?? 0, credit_cents: l.creditCents ?? 0, sphere: l.sphere, cost_center_id: l.costCenterId ?? null, tax_rate_id: l.taxRateId ?? null, text: l.text ?? null })))
    .execute();
  return entry;
}

/** Net and tax part of a gross amount at a rate in basis points (19 % = 1900); tax is what remains after rounding the net. */
export function splitGross(grossCents: number, rateBp: number) {
  const net = Math.round((grossCents * 10_000) / (10_000 + rateBp));
  return { net, tax: grossCents - net };
}

/** Reverses a posted entry with swapped sides; the original stays unchanged. */
export async function reverseEntry(tx: Db, organizationId: string, entryId: string, date: string, createdBy: string | null, source: 'reversal' | 'allocation_reversal' = 'reversal', sourceId: string | null = null) {
  const e = await tx.selectFrom('journal_entry').selectAll().where('id', '=', entryId).where('organization_id', '=', organizationId).executeTakeFirst();
  if (!e) throw new Problem(404, 'not-found', 'Buchung nicht gefunden.');
  if (e.reverses_id) throw new Problem(409, 'is-reversal', 'Eine Stornobuchung wird nicht noch einmal storniert.');
  const done = await tx.selectFrom('journal_entry').select('id').where('reverses_id', '=', e.id).executeTakeFirst();
  if (done) throw new Problem(409, 'reversed', 'Diese Buchung ist schon storniert.');
  const lines = await tx.selectFrom('journal_line').selectAll().where('entry_id', '=', e.id).execute();
  return postEntry(tx, organizationId, {
    date,
    text: `Storno Nr. ${e.number}: ${e.text}`.slice(0, 300),
    source,
    sourceId,
    reversesId: e.id,
    createdBy,
    lines: lines.map((l) => ({ accountId: l.account_id, debitCents: Number(l.credit_cents), creditCents: Number(l.debit_cents), sphere: l.sphere, costCenterId: l.cost_center_id, taxRateId: l.tax_rate_id, text: l.text })),
  });
}

/** One journal writer per club at a time (gapless numbers, cash checks, sync). Re-entrant inside a transaction. */
export async function lockJournal(tx: Db, organizationId: string) {
  await sql`select pg_advisory_xact_lock(hashtext(${`journal:${organizationId}`}))`.execute(tx);
}

/** Splits a paid amount over the invoice's VAT groups in proportion to their gross totals; the last group takes the rest. */
export function splitPayment(amountCents: number, invoiceTotalCents: number, groups: { ratePct: number; grossCents: number }[]) {
  const live = groups.filter((g) => g.grossCents !== 0);
  if (!live.length || !invoiceTotalCents) return [{ ratePct: 0, grossCents: amountCents }];
  let left = amountCents;
  return live.map((g, i) => {
    const part = i === live.length - 1 ? left : Math.round((amountCents * g.grossCents) / invoiceTotalCents);
    left -= part;
    return { ratePct: g.ratePct, grossCents: part };
  });
}

/**
 * Cash basis: a confirmed payment posts money in or out; issuing an invoice posts nothing.
 * Posts every confirmed allocation that has no entry yet (split by the invoice's VAT rates) and reverses entries of
 * reversed allocations. Each posting re-checks under the journal lock, so concurrent syncs never collide.
 */
export async function syncAllocations(db: Db, organizationId: string) {
  const settings = await db.selectFrom('ledger_setting').selectAll().where('organization_id', '=', organizationId).executeTakeFirst();
  if (!settings) return 0;
  const pending = await db
    .selectFrom('allocation')
    .innerJoin('invoice', 'invoice.id', 'allocation.invoice_id')
    .leftJoin('bank_transaction', 'bank_transaction.id', 'allocation.bank_transaction_id')
    .leftJoin('bank_account', 'bank_account.id', 'bank_transaction.bank_account_id')
    .select(['allocation.id', 'allocation.invoice_id', 'allocation.amount_cents', 'allocation.booked_on', 'allocation.method', 'allocation.created_by', 'invoice.kind', 'invoice.number', 'invoice.total_cents', 'bank_account.ledger_account_id'])
    .where('allocation.organization_id', '=', organizationId)
    .where('allocation.status', '=', 'confirmed')
    .where('allocation.method', '!=', 'write_off')
    // Payments inside a closed period were posted before the lock (locking refuses otherwise) or predate the ledger.
    .$if(!!settings.lock_date, (q) => q.where('allocation.booked_on', '>', settings.lock_date!))
    .where((eb) => eb.not(eb.exists(eb.selectFrom('journal_entry').select('journal_entry.id').where('journal_entry.source', '=', 'allocation').whereRef('journal_entry.source_id', '=', 'allocation.id'))))
    .orderBy('allocation.booked_on')
    .execute();
  const accounts = await db.selectFrom('ledger_account').select(['id', 'default_sphere']).where('organization_id', '=', organizationId).execute();
  const rates = await db.selectFrom('tax_rate').selectAll().where('organization_id', '=', organizationId).execute();
  const sphereOf = (id: string) => accounts.find((a) => a.id === id)?.default_sphere ?? 'ideell';
  let posted = 0;
  for (const a of pending) {
    const money = a.method === 'cash' ? settings.cash_account_id : (a.ledger_account_id ?? settings.bank_account_id);
    const income = a.kind === 'dunning_fee' ? settings.dunning_account_id : a.kind === 'other' ? settings.other_income_account_id : settings.fee_account_id;
    if (!money || !income) continue;
    const amount = Number(a.amount_cents);
    // A paid credit note is money going back out.
    const out = a.kind === 'credit_note';
    const sphere = sphereOf(income);
    const groups = await db.selectFrom('invoice_line').select(['tax_rate', sql<number>`sum(total_cents)::bigint`.as('gross')]).where('invoice_id', '=', a.invoice_id).groupBy('tax_rate').execute();
    const lines: Line[] = [{ accountId: money, debitCents: out ? 0 : amount, creditCents: out ? amount : 0, sphere }];
    for (const g of splitPayment(amount, Number(a.total_cents), groups.map((g) => ({ ratePct: Number(g.tax_rate), grossCents: Number(g.gross) })))) {
      const rate = g.ratePct ? rates.find((r) => r.rate_bp === Math.round(g.ratePct * 100) && r.valid_from <= a.booked_on && (!r.valid_to || r.valid_to >= a.booked_on)) : undefined;
      const { net, tax } = splitGross(g.grossCents, rate && rate.output_account_id ? rate.rate_bp : 0);
      const side = (c: number) => (out ? { debitCents: c, creditCents: 0 } : { debitCents: 0, creditCents: c });
      lines.push({ accountId: income, ...side(net), sphere, taxRateId: rate?.id ?? null });
      if (tax) lines.push({ accountId: rate!.output_account_id!, ...side(tax), sphere, taxRateId: rate!.id });
    }
    const done = await db.transaction().execute(async (tx) => {
      await lockJournal(tx, organizationId);
      const exists = await tx.selectFrom('journal_entry').select('id').where('source', '=', 'allocation').where('source_id', '=', a.id).executeTakeFirst();
      if (exists) return false;
      await postEntry(tx, organizationId, { date: a.booked_on, text: `${out ? 'Erstattung' : 'Zahlung'} ${a.number ?? ''}`.trim(), source: 'allocation', sourceId: a.id, createdBy: a.created_by, lines });
      return true;
    });
    if (done) posted++;
  }
  // Reversed allocations: reverse their entry once, dated on the day of the reversal (or the first open day).
  const reversed = await db
    .selectFrom('allocation')
    .innerJoin('journal_entry as e', (j) => j.onRef('e.source_id', '=', 'allocation.id').on('e.source', '=', 'allocation'))
    .innerJoin('organization', 'organization.id', 'allocation.organization_id')
    .select(['allocation.id', 'e.id as entryId', sql<string>`(allocation.reversed_at at time zone organization.time_zone)::date::text`.as('day')])
    .where('allocation.organization_id', '=', organizationId)
    .where('allocation.status', '=', 'reversed')
    .where((eb) => eb.not(eb.exists(eb.selectFrom('journal_entry as r').select('r.id').whereRef('r.reverses_id', '=', 'e.id'))))
    .execute();
  const today = await orgToday(db, organizationId);
  for (const r of reversed) {
    const done = await db.transaction().execute(async (tx) => {
      await lockJournal(tx, organizationId);
      if (await tx.selectFrom('journal_entry').select('id').where('reverses_id', '=', r.entryId).executeTakeFirst()) return false;
      const lock = (await tx.selectFrom('ledger_setting').select('lock_date').where('organization_id', '=', organizationId).executeTakeFirst())?.lock_date ?? null;
      const open = lock ? dayAfter(lock) : null;
      const date = [r.day ?? today, open].filter((d): d is string => !!d).sort().at(-1)!;
      await reverseEntry(tx, organizationId, r.entryId, date > today ? today : date, null, 'allocation_reversal', r.id);
      return true;
    });
    if (done) posted++;
  }
  return posted;
}

const dayAfter = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Confirmed payments after `after` up to `date` without a posting yet (locking would hide them for good). */
export async function unpostedPayments(db: Db, organizationId: string, after: string | null, date: string) {
  const r = await db
    .selectFrom('allocation')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'confirmed')
    .where('method', '!=', 'write_off')
    .where('booked_on', '<=', date)
    .$if(!!after, (q) => q.where('booked_on', '>', after!))
    .where((eb) => eb.not(eb.exists(eb.selectFrom('journal_entry').select('journal_entry.id').where('journal_entry.source', '=', 'allocation').whereRef('journal_entry.source_id', '=', 'allocation.id'))))
    .executeTakeFirstOrThrow();
  return r.n;
}

/** Cash may not go below zero on any day from `date` on. */
export async function assertCashNotNegative(tx: Db, organizationId: string, accountId: string, date: string, deltaCents: number) {
  if (deltaCents >= 0) return;
  const rows = await sql<{ d: string; balance: number }>`
    select d::text, (select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint from journal_line l join journal_entry e on e.id = l.entry_id
                     where l.account_id = ${accountId} and e.entry_date <= d)::bigint as balance
    from (select ${date}::date as d union select distinct e.entry_date from journal_line l join journal_entry e on e.id = l.entry_id
          where l.account_id = ${accountId} and e.entry_date > ${date}::date) days`.execute(tx);
  const low = Math.min(...rows.rows.map((r) => Number(r.balance)));
  if (low + deltaCents < 0) throw new Problem(409, 'cash-negative', 'Die Kasse würde ins Minus rutschen.', `Bestand an diesem Tag oder später: ${(low / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}. Erfasse zuerst die Einzahlung.`);
  void organizationId;
}
