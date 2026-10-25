import { sql } from 'kysely';
import type { Db } from './db.ts';
import { CHILDREN } from './exports/full.ts';
import { Problem } from './http/problem.ts';

/** Keyed by user, not by club; everything else carries organization_id or is a child in CHILDREN. */
const USER_CHILDREN = ['session', 'totp_recovery_code'];

/**
 * Deletes a club with everything it owns when it leaves a managed installation (AVV section 6). Issued invoices,
 * journal and receipts are immutable by trigger, so this runs with triggers off (session_replication_role = replica,
 * which needs a database superuser). With foreign keys unchecked, a final scan of every foreign key proves that no
 * row of another club pointed into the deleted one; otherwise the whole deletion rolls back.
 * Files go with the next sweep (sweepFiles removes blobs no file row points to).
 */
export async function purgeTenant(db: Db, organizationId: string) {
  return db.transaction().execute(async (tx) => {
    const su = await sql<{ ok: boolean }>`select rolsuper as ok from pg_roles where rolname = current_user`.execute(tx);
    if (!su.rows[0]?.ok) throw new Problem(409, 'purge-needs-superuser', 'Zum Löschen eines Vereins braucht die Datenbankverbindung Superuser-Rechte (wie in der mitgelieferten Docker-Installation).');
    await sql`set local session_replication_role = replica`.execute(tx);
    const counts: Record<string, number> = {};
    const del = async (table: string, q: Promise<{ numAffectedRows?: bigint }[]>) => {
      const n = Number((await q)[0]?.numAffectedRows ?? 0);
      if (n) counts[table] = (counts[table] ?? 0) + n;
    };
    for (const [child, { parent, key }] of Object.entries(CHILDREN)) {
      await del(child, sql`delete from ${sql.table(child)} where ${sql.ref(key)} in (select id from ${sql.table(parent)} where organization_id = ${organizationId})`.execute(tx).then((r) => [r]));
    }
    for (const t of USER_CHILDREN) await del(t, sql`delete from ${sql.table(t)} where user_id in (select id from app_user where organization_id = ${organizationId})`.execute(tx).then((r) => [r]));
    const tables = await sql<{ t: string }>`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`.execute(tx);
    for (const { t } of tables.rows) await del(t, sql`delete from ${sql.table(t)} where organization_id = ${organizationId}`.execute(tx).then((r) => [r]));
    await del('organization', sql`delete from organization where id = ${organizationId}`.execute(tx).then((r) => [r]));
    await assertNoDanglingReferences(tx);
    return counts;
  });
}

/** Every foreign key, checked by hand because they were not enforced during the purge. */
async function assertNoDanglingReferences(tx: Db) {
  const fks = await sql<{ name: string; child: string; cols: string[]; parent: string; refs: string[] }>`
    select con.conname as name, ch.relname as child, pa.relname as parent,
      array(select a.attname from unnest(con.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i)::text[] as cols,
      array(select a.attname from unnest(con.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i)::text[] as refs
    from pg_constraint con join pg_class ch on ch.oid = con.conrelid join pg_class pa on pa.oid = con.confrelid
    where con.contype = 'f' and ch.relnamespace = 'public'::regnamespace`.execute(tx);
  for (const fk of fks.rows) {
    const notNull = sql.join(fk.cols.map((c) => sql`c.${sql.ref(c)} is not null`), sql` and `);
    const match = sql.join(fk.cols.map((c, i) => sql`p.${sql.ref(fk.refs[i]!)} = c.${sql.ref(c)}`), sql` and `);
    const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(fk.child)} c where ${notNull} and not exists (select 1 from ${sql.table(fk.parent)} p where ${match})`.execute(tx);
    if (r.rows[0]!.n > 0) throw new Problem(409, 'purge-dangling', `Löschen abgebrochen: ${r.rows[0]!.n} Zeilen in ${fk.child} verweisen noch auf gelöschte Daten (${fk.name}). Nichts wurde gelöscht.`);
  }
}
