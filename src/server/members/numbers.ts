import type { Db } from '../db.ts';

/**
 * Next number from a pattern such as `M-{YYYY}-{seq:4}`. `{seq:n}` pads to n digits; patterns with
 * `{YYYY}` count per year. The sequence row is locked, so numbers stay gapless inside the transaction.
 */
export async function nextNumber(tx: Db, organizationId: string, kind: string, pattern: string, date: string) {
  const yearly = pattern.includes('{YYYY}');
  const year = yearly ? Number(date.slice(0, 4)) : 0;
  await tx.insertInto('number_sequence').values({ organization_id: organizationId, kind, year, next_value: 1 }).onConflict((oc) => oc.doNothing()).execute();
  const row = await tx
    .selectFrom('number_sequence')
    .select('next_value')
    .where('organization_id', '=', organizationId)
    .where('kind', '=', kind)
    .where('year', '=', year)
    .forUpdate()
    .executeTakeFirstOrThrow();
  await tx
    .updateTable('number_sequence')
    .set({ next_value: row.next_value + 1 })
    .where('organization_id', '=', organizationId)
    .where('kind', '=', kind)
    .where('year', '=', year)
    .execute();
  return formatNumber(pattern, row.next_value, date);
}

export function formatNumber(pattern: string, seq: number, date: string) {
  return pattern
    .replaceAll('{YYYY}', date.slice(0, 4))
    .replace(/\{seq(?::(\d+))?\}/g, (_, pad) => String(seq).padStart(Number(pad ?? 0), '0'));
}
