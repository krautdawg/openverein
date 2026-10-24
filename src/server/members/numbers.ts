import type { Db } from '../db.ts';

/**
 * Next number from a pattern such as `M-{YYYY}-{seq:4}`. `{seq:n}` pads to n digits; patterns with
 * `{YYYY}` count per year. The sequence row is locked, so numbers stay gapless inside the transaction.
 */
export async function nextNumber(tx: Db, organizationId: string, kind: string, pattern: string, date: string, exists?: (n: string) => Promise<boolean>) {
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
  // Skip numbers that already exist (entered by hand, or left over from an earlier pattern),
  // otherwise one collision would block automatic numbering for good.
  let value = row.next_value;
  let number = formatNumber(pattern, value, date);
  while (exists && (await exists(number))) number = formatNumber(pattern, ++value, date);
  await tx
    .updateTable('number_sequence')
    .set({ next_value: value + 1 })
    .where('organization_id', '=', organizationId)
    .where('kind', '=', kind)
    .where('year', '=', year)
    .execute();
  return number;
}

export function formatNumber(pattern: string, seq: number, date: string) {
  return pattern
    .replaceAll('{YYYY}', date.slice(0, 4))
    .replace(/\{seq(?::(\d+))?\}/g, (_, pad) => String(seq).padStart(Number(pad ?? 0), '0'));
}
