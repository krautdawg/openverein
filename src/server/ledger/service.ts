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
  await sql`select pg_advisory_xact_lock(hashtext(${`journal:${organizationId}`}))`.execute(tx);
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

/**
 * Cash basis: a confirmed payment posts money in or out; issuing an invoice posts nothing.
 * Posts every confirmed allocation that has no entry yet and reverses entries of reversed allocations.
 * Idempotent (unique source index); runs before journal reads, reports, exports and lock changes.
 */
export async function syncAllocations(db: Db, organizationId: string) {
  const settings = await db.selectFrom('ledger_setting').selectAll().where('organization_id', '=', organizationId).executeTakeFirst();
  if (!settings) return 0;
  const pending = await db
    .selectFrom('allocation')
    .innerJoin('invoice', 'invoice.id', 'allocation.invoice_id')
    .leftJoin('bank_transaction', 'bank_transaction.id', 'allocation.bank_transaction_id')
    .leftJoin('bank_account', 'bank_account.id', 'bank_transaction.bank_account_id')
    .select(['allocation.id', 'allocation.amount_cents', 'allocation.booked_on', 'allocation.method', 'allocation.created_by', 'invoice.kind', 'invoice.number', 'bank_account.ledger_account_id'])
    .where('allocation.organization_id', '=', organizationId)
    .where('allocation.status', '=', 'confirmed')
    .where('allocation.method', '!=', 'write_off')
    // Payments inside a closed period were posted before the lock (the lock syncs first) or predate the ledger.
    .$if(!!settings.lock_date, (q) => q.where('allocation.booked_on', '>', settings.lock_date!))
    .where((eb) => eb.not(eb.exists(eb.selectFrom('journal_entry').select('journal_entry.id').where('journal_entry.source', '=', 'allocation').whereRef('journal_entry.source_id', '=', 'allocation.id'))))
    .orderBy('allocation.booked_on')
    .execute();
  const accounts = await db.selectFrom('ledger_account').select(['id', 'default_sphere']).where('organization_id', '=', organizationId).execute();
  const sphereOf = (id: string) => accounts.find((a) => a.id === id)?.default_sphere ?? 'ideell';
  let posted = 0;
  for (const a of pending) {
    const money = a.method === 'cash' ? settings.cash_account_id : (a.ledger_account_id ?? settings.bank_account_id);
    const income = a.kind === 'dunning_fee' ? settings.dunning_account_id : a.kind === 'other' ? settings.other_income_account_id : settings.fee_account_id;
    if (!money || !income) continue;
    const amount = Number(a.amount_cents);
    // A paid credit note is money going back out.
    const out = a.kind === 'credit_note';
    await db.transaction().execute(async (tx) => {
      await postEntry(tx, organizationId, {
        date: a.booked_on,
        text: `${out ? 'Erstattung' : 'Zahlung'} ${a.number ?? ''}`.trim(),
        source: 'allocation',
        sourceId: a.id,
        createdBy: a.created_by,
        lines: [
          { accountId: money, debitCents: out ? 0 : amount, creditCents: out ? amount : 0, sphere: sphereOf(income) },
          { accountId: income, debitCents: out ? amount : 0, creditCents: out ? 0 : amount, sphere: sphereOf(income) },
        ],
      });
    });
    posted++;
  }
  // Reversed allocations: reverse their entry once, dated today unless the period of the reversal is still open.
  const reversed = await db
    .selectFrom('allocation')
    .innerJoin('journal_entry as e', (j) => j.onRef('e.source_id', '=', 'allocation.id').on('e.source', '=', 'allocation'))
    .select(['allocation.id', 'e.id as entryId', 'allocation.reversed_at'])
    .where('allocation.organization_id', '=', organizationId)
    .where('allocation.status', '=', 'reversed')
    .where((eb) => eb.not(eb.exists(eb.selectFrom('journal_entry as r').select('r.id').whereRef('r.reverses_id', '=', 'e.id'))))
    .execute();
  const today = await orgToday(db, organizationId);
  for (const r of reversed) {
    await db.transaction().execute((tx) => reverseEntry(tx, organizationId, r.entryId, today, null, 'allocation_reversal', r.id));
    posted++;
  }
  return posted;
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
