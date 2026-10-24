import { sql } from 'kysely';
import type { Db } from '../db.ts';
import { refreshPayment } from '../invoices/service.ts';
import { audit, type AuditActor } from '../audit.ts';

/**
 * Matching rules, in order (spec sepa: matching):
 *  1. end-to-end ID of a collection item          → settle the item (automatic)
 *  2. return of a collected item (reason code)     → return debit (automatic)
 *  3. batch credit equal to a file's control sum   → settle the whole file (automatic)
 *  4. invoice number in the text + exact amount    → allocate (automatic)
 *  5. invoice number with another amount, or the payer's IBAN with one open invoice of that amount → suggestion only
 */

export interface Suggestion {
  invoiceId: string;
  number: string;
  recipientName: string;
  openCents: number;
  score: number;
  rule: string;
}

type Tx = { id: string; organization_id: string; booking_date: string; amount_cents: number; end_to_end_id: string | null; return_reason: string | null; remittance: string; counterparty_iban_hash: string | null; status: string };

/** Regex for invoice numbers built from the organisation's pattern, e.g. R-{YYYY}-{seq:5} → R-\d{4}-\d{5}. */
export function invoiceNumberRegex(pattern: string) {
  const src = pattern
    .split(/(\{YYYY\}|\{seq(?::\d+)?\})/)
    .map((p) => {
      if (p === '{YYYY}') return '\\d{4}';
      const seq = p.match(/^\{seq(?::(\d+))?\}$/);
      if (seq) return seq[1] ? `\\d{${seq[1]}}` : '\\d+';
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(src, 'gi');
}

/** Invoice numbers mentioned in a remittance text (banks often break lines inside them). */
export const numbersIn = (text: string, re: RegExp): string[] => [...new Set([...(text.replace(/\s+/g, '').match(re) ?? []), ...(text.match(re) ?? [])].map((n) => n.toUpperCase()))];

async function allocate(tx: Db, t: Tx, invoiceId: string, amountCents: number, method: 'transfer' | 'direct_debit', actor: AuditActor | null, collectionItemId: string | null = null) {
  await tx.insertInto('allocation').values({ organization_id: t.organization_id, invoice_id: invoiceId, amount_cents: amountCents, booked_on: t.booking_date, method, bank_transaction_id: t.id, collection_item_id: collectionItemId, note: null, created_by: actor?.userId ?? null }).execute();
  await refreshPayment(tx, invoiceId);
}

async function settleItems(tx: Db, t: Tx, itemIds: string[], actor: AuditActor | null) {
  for (const itemId of itemIds) {
    const links = await tx.selectFrom('collection_item_invoice').select(['invoice_id', 'amount_cents']).where('item_id', '=', itemId).where('live', '=', true).execute();
    for (const l of links) {
      const inv = await tx.selectFrom('invoice').select(['status', 'total_cents', 'paid_cents']).where('id', '=', l.invoice_id).forUpdate().executeTakeFirstOrThrow();
      const amount = Math.min(l.amount_cents, inv.total_cents - inv.paid_cents);
      if (amount > 0 && ['open', 'partially_paid'].includes(inv.status)) await allocate(tx, t, l.invoice_id, amount, 'direct_debit', actor, itemId);
    }
    await tx.updateTable('collection_item').set({ status: 'settled' }).where('id', '=', itemId).execute();
  }
  // A run whose items are all settled or returned is finished.
  await sql`update collection_run r set status = 'settled' where r.id in (select run_id from collection_item where id = any(${itemIds}::uuid[]))
    and not exists (select 1 from collection_item i where i.run_id = r.id and i.status = 'included') and r.status not in ('released', 'settled')`.execute(tx);
  await tx.updateTable('bank_transaction').set({ status: 'matched' }).where('id', '=', t.id).execute();
}

/** Return debit: the item is returned, its payments are reversed, the invoice is open again and can be collected again. */
export async function processReturn(tx: Db, t: Tx, itemId: string, actor: AuditActor | null) {
  const item = await tx.selectFrom('collection_item').selectAll().where('id', '=', itemId).forUpdate().executeTakeFirstOrThrow();
  const allocations = await tx.selectFrom('allocation').select(['id', 'invoice_id']).where('collection_item_id', '=', itemId).where('status', '=', 'confirmed').execute();
  for (const a of allocations) {
    await tx.updateTable('allocation').set({ status: 'reversed', reversed_at: new Date() }).where('id', '=', a.id).execute();
    await refreshPayment(tx, a.invoice_id);
  }
  await tx.updateTable('collection_item').set({ status: 'returned' }).where('id', '=', itemId).execute();
  await tx.updateTable('collection_item_invoice').set({ live: false }).where('item_id', '=', itemId).execute();
  const fee = Math.max(0, -t.amount_cents - item.amount_cents);
  await tx.insertInto('return_debit').values({ organization_id: t.organization_id, bank_transaction_id: t.id, collection_item_id: itemId, reason_code: t.return_reason, fee_cents: fee, created_by: actor?.userId ?? null }).execute();
  await tx.updateTable('bank_transaction').set({ status: 'matched' }).where('id', '=', t.id).execute();
  // MD01 (no mandate) and MD06 (refund requested) put the mandate on hold until someone looks at it.
  if (t.return_reason === 'MD01' || t.return_reason === 'MD06') {
    await tx.updateTable('sepa_mandate').set({ status: 'pending_evidence', updated_at: new Date() }).where('id', '=', item.mandate_id!).where('status', '=', 'active').execute();
  }
  await audit(tx, t.organization_id, actor, { action: 'collection_item.returned', entityType: 'collection_item', entityId: itemId, diff: { reason: [null, t.return_reason], feeCents: [null, fee] } });
  return { fee };
}

/** Runs the automatic rules over unmatched transactions. Returns how many were matched and how many were returns. */
export async function autoMatch(db: Db, organizationId: string, actor: AuditActor | null, onlyIds?: string[]) {
  let matched = 0;
  let returns = 0;
  const org = await db.selectFrom('organization').select('invoice_number_pattern').where('id', '=', organizationId).executeTakeFirstOrThrow();
  const numberRe = invoiceNumberRegex(org.invoice_number_pattern);
  let q = db.selectFrom('bank_transaction').selectAll().where('organization_id', '=', organizationId).where('status', '=', 'unmatched');
  if (onlyIds) q = q.where('id', 'in', onlyIds.length ? onlyIds : ['00000000-0000-0000-0000-000000000000']);
  const txs = await q.orderBy('booking_date').execute();

  for (const t of txs) {
    await db.transaction().execute(async (tx) => {
      const locked = await tx.selectFrom('bank_transaction').selectAll().where('id', '=', t.id).forUpdate().executeTakeFirstOrThrow();
      if (locked.status !== 'unmatched') return;
      const item = locked.end_to_end_id
        ? await tx.selectFrom('collection_item').selectAll().where('organization_id', '=', organizationId).where('end_to_end_id', '=', locked.end_to_end_id).executeTakeFirst()
        : undefined;
      // Rule 2: return of a collected item.
      if (item && locked.amount_cents < 0 && ['included', 'settled'].includes(item.status)) {
        await processReturn(tx, locked, item.id, actor);
        returns++;
        return;
      }
      // Rule 1: credit for one collection item.
      if (item && locked.amount_cents > 0 && item.status === 'included' && locked.amount_cents === item.amount_cents) {
        await settleItems(tx, locked, [item.id], actor);
        matched++;
        return;
      }
      if (locked.amount_cents <= 0) return;
      // Rule 3: one batch credit for a whole file.
      const file = await tx
        .selectFrom('collection_file')
        .innerJoin('collection_run', 'collection_run.id', 'collection_file.run_id')
        .select(['collection_file.id'])
        .where('collection_file.organization_id', '=', organizationId)
        .where('collection_file.control_sum_cents', '=', locked.amount_cents)
        .where('collection_run.kind', '=', 'debit')
        .where('collection_run.status', 'in', ['downloaded', 'submitted'])
        .where('collection_run.collection_date', '<=', locked.booking_date)
        .where(sql<boolean>`collection_run.collection_date >= ${locked.booking_date}::date - 10`)
        .where((eb) => eb.not(eb.exists(eb.selectFrom('collection_item').select('id').whereRef('collection_item.file_id', '=', 'collection_file.id').where('collection_item.status', '<>', 'included'))))
        .executeTakeFirst();
      if (file) {
        const items = await tx.selectFrom('collection_item').select('id').where('file_id', '=', file.id).execute();
        await settleItems(tx, locked, items.map((i) => i.id), actor);
        matched++;
        return;
      }
      // Rule 4: invoice number in the remittance text with the exact open amount.
      const numbers = numbersIn(locked.remittance, numberRe);
      if (numbers.length === 1) {
        const inv = await tx.selectFrom('invoice').select(['id', 'total_cents', 'paid_cents', 'status']).where('organization_id', '=', organizationId).where(sql`upper(number)`, '=', numbers[0]!).forUpdate().executeTakeFirst();
        if (inv && ['open', 'partially_paid'].includes(inv.status) && inv.total_cents - inv.paid_cents === locked.amount_cents) {
          await allocate(tx, locked, inv.id, locked.amount_cents, 'transfer', actor);
          await tx.updateTable('bank_transaction').set({ status: 'matched' }).where('id', '=', locked.id).execute();
          matched++;
        }
      }
    });
  }
  return { matched, returns };
}

/** Suggestions for the reconciliation inbox (never booked without a click). */
export async function suggestionsFor(db: Db, organizationId: string, t: Tx, numberRe: RegExp): Promise<Suggestion[]> {
  if (t.amount_cents <= 0) return [];
  const out: Suggestion[] = [];
  const open = (q: ReturnType<typeof base>) => q.where('invoice.status', 'in', ['open', 'partially_paid']);
  const base = () =>
    db
      .selectFrom('invoice')
      .select(['invoice.id', 'invoice.number', 'invoice.total_cents', 'invoice.paid_cents', 'invoice.recipient'])
      .where('invoice.organization_id', '=', organizationId)
      .where('invoice.kind', 'in', ['membership', 'other', 'dunning_fee']);
  const add = (rows: { id: string; number: string | null; total_cents: number; paid_cents: number; recipient: unknown }[], score: number, rule: string) => {
    for (const r of rows) {
      if (out.some((o) => o.invoiceId === r.id)) continue;
      out.push({ invoiceId: r.id, number: r.number!, recipientName: (r.recipient as { recipient: { name: string } }).recipient.name, openCents: r.total_cents - r.paid_cents, score, rule });
    }
  };
  const numbers = numbersIn(t.remittance, numberRe);
  if (numbers.length) add(await open(base()).where(sql`upper(invoice.number)`, 'in', numbers).execute(), 90, 'Rechnungsnummer im Verwendungszweck');
  if (t.counterparty_iban_hash) {
    const persons = db.selectFrom('sepa_mandate').select('person_id').where('iban_hash', '=', t.counterparty_iban_hash);
    const rows = await open(base()).where('invoice.recipient_person_id', 'in', persons).execute();
    add(rows.filter((r) => r.total_cents - r.paid_cents === t.amount_cents), 75, 'Bekannte IBAN, passender Betrag');
    add(rows, 50, 'Bekannte IBAN');
  }
  return out.slice(0, 5);
}
