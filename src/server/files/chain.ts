import { sql, type Selectable } from 'kysely';
import type { Db, FileTable } from '../db.ts';

type FileRow = Selectable<FileTable>;

/**
 * A document is the chain of its versions. Locks the current version (so a parallel hold or delete waits)
 * and returns the whole chain, newest first. Null when `headId` is not a current version.
 */
export async function lockChain(tx: Db, headId: string) {
  const head = await tx.selectFrom('file').select('id').where('id', '=', headId).where('superseded_at', 'is', null).forUpdate().executeTakeFirst();
  if (!head) return null;
  const rows = await sql<FileRow & { depth: number }>`
    with recursive chain as (
      select f.*, 0 as depth from file f where f.id = ${headId}
      union all select f.*, c.depth + 1 from file f join chain c on f.id = c.previous_id where c.depth < 1000
    ) select * from chain order by depth`.execute(tx);
  return rows.rows;
}

/** Why a chain may not be deleted today, or null. The last retention day itself still counts. */
export function deletionBlocker(chain: FileRow[], today: string) {
  if (chain.some((v) => v.legal_hold)) return 'Für diese Datei gilt eine Löschsperre.';
  const until = chain.map((v) => v.retain_until).filter((x): x is string => !!x && x >= today).sort().at(-1);
  return until ? `Diese Datei ist ein Beleg und muss bis ${until.split('-').reverse().join('.')} aufbewahrt werden.` : null;
}

/** Deletes rows newest first, so no row still points at a deleted predecessor. Bytes go later, in the sweep. */
export async function deleteChain(tx: Db, chain: FileRow[]) {
  for (const v of chain) await tx.deleteFrom('file').where('id', '=', v.id).execute();
}
