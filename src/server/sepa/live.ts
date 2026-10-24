import type { Db } from '../db.ts';
import { Problem } from '../http/problem.ts';

/**
 * An invoice in a live collection item (generated, downloaded, submitted, not yet settled or returned)
 * will be debited by the bank. Paying, cancelling or writing it off elsewhere would charge the member
 * twice, so every such path asks this first.
 */
export async function isLive(db: Db, invoiceId: string) {
  const row = await db
    .selectFrom('collection_item_invoice')
    .innerJoin('collection_item', 'collection_item.id', 'collection_item_invoice.item_id')
    .select('collection_item.id')
    .where('collection_item_invoice.invoice_id', '=', invoiceId)
    .where('collection_item_invoice.live', '=', true)
    .where('collection_item.status', '=', 'included')
    .executeTakeFirst();
  return !!row;
}

export async function assertNotLive(db: Db, invoiceId: string) {
  if (await isLive(db, invoiceId)) {
    throw new Problem(409, 'in-collection', 'Die Rechnung steckt in einem laufenden Lastschrifteinzug.', 'Warte die Gutschrift oder Rücklastschrift ab oder gib den Einzug frei, bevor Du sie anders bezahlst, stornierst oder ausbuchst.');
  }
}
