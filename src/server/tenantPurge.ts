import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { config } from './config.ts';
import type { Db } from './db.ts';
import { CHILDREN } from './exports/full.ts';
import { notFound, Problem } from './http/problem.ts';

/** Keyed by user, not by club; everything else carries organization_id or is a child in CHILDREN. */
const USER_CHILDREN = ['session', 'totp_recovery_code'];
/** Global records about the club that must outlive it. */
const KEEP = new Set(['operator_event']);

/** Two purges of one club never run at the same time (an export checks its snapshot instead). */
export const lockClub = (tx: Db, organizationId: string) => sql`select pg_advisory_xact_lock(hashtext(${`openverein:club:${organizationId}`}))`.execute(tx);

/**
 * Deletes a club with everything it owns when it leaves a managed installation (AVV section 6). Issued invoices,
 * journal and receipts are immutable by trigger, so this runs with triggers off (session_replication_role = replica,
 * which needs a database superuser). With foreign keys unchecked, a final scan of every foreign key in every schema
 * proves that no row anywhere still points into the deleted club; otherwise the whole deletion rolls back.
 * The deletion is written to the erasure log file (and synced) before anything is deleted, then to operator_event,
 * so restoring an older backup deletes the club again at start-up (replayErasures); a deletion that fails after the
 * intent is written stays pending and is repeated at the next start. Files go with the next sweep (sweepFiles removes unreferenced blobs).
 * With `confirmHostname`, the club's host name is checked inside the transaction, on the locked row.
 */
export async function purgeTenant(db: Db, organizationId: string, confirmHostname?: string) {
  let intent = false;
  const counts = await db.transaction().execute(async (tx) => {
    const su = await sql<{ ok: boolean }>`select rolsuper as ok from pg_roles where rolname = current_user`.execute(tx);
    if (!su.rows[0]?.ok) throw new Problem(409, 'purge-needs-superuser', 'Zum Löschen eines Vereins braucht die Datenbankverbindung Superuser-Rechte (wie in der mitgelieferten Docker-Installation).');
    await lockClub(tx, organizationId);
    const o = await tx.selectFrom('organization').select(['id', 'hostname']).where('id', '=', organizationId).forUpdate().executeTakeFirst();
    if (!o) throw notFound('Verein');
    if (confirmHostname !== undefined && (!o.hostname || confirmHostname !== o.hostname)) throw new Problem(400, 'validation', 'Zur Bestätigung den Hostnamen des Vereins angeben.', undefined, { errors: [{ field: 'confirmHostname', message: 'Stimmt nicht mit dem Hostnamen überein.' }] });
    // The intent first: a crash or a full disk after the commit must not leave a deletion that a restore undoes.
    await recordPurgeFile(organizationId);
    intent = true;
    await sql`set local session_replication_role = replica`.execute(tx);
    const counts: Record<string, number> = {};
    const del = async (table: string, q: Promise<{ numAffectedRows?: bigint }>) => {
      const n = Number((await q).numAffectedRows ?? 0);
      if (n) counts[table] = (counts[table] ?? 0) + n;
    };
    for (const [child, { parent, key }] of Object.entries(CHILDREN)) {
      await del(child, sql`delete from ${sql.table(child)} where ${sql.ref(key)} in (select id from ${sql.table(parent)} where organization_id = ${organizationId})`.execute(tx));
    }
    for (const t of USER_CHILDREN) await del(t, sql`delete from ${sql.table(t)} where user_id in (select id from app_user where organization_id = ${organizationId})`.execute(tx));
    const tables = await sql<{ t: string }>`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`.execute(tx);
    for (const { t } of tables.rows.filter((r) => !KEEP.has(r.t))) await del(t, sql`delete from ${sql.table(t)} where organization_id = ${organizationId}`.execute(tx));
    await del('organization', sql`delete from organization where id = ${organizationId}`.execute(tx));
    await assertNoDanglingReferences(tx);
    await sql`set local session_replication_role = origin`.execute(tx);
    await tx.insertInto('operator_event').values({ action: 'tenant.purged', organization_id: organizationId, hostname: o.hostname, detail: JSON.stringify({ deleted: counts }) }).execute();
    return counts;
  }).catch(async (err: unknown) => {
    // Rolled back (the club is still there): the intent is withdrawn, so a restart does not try again.
    if (intent && (await db.selectFrom('organization').select('id').where('id', '=', organizationId).executeTakeFirst())) await recordPurgeFile(organizationId, false);
    throw err;
  });
  return counts;
}

/** The same file as person erasures: `ovctl restore` keeps it, and start-up replays it. */
export async function recordPurgeFile(organizationId: string, purge = true) {
  await mkdir(config.filesDir, { recursive: true });
  const f = await open(join(config.filesDir, 'erasure-log.jsonl'), 'a', 0o600);
  try {
    await f.appendFile(JSON.stringify({ o: organizationId, purge, at: new Date().toISOString() }) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}

/** Every foreign key in every user schema, checked by hand because they were not enforced during the purge. */
async function assertNoDanglingReferences(tx: Db) {
  const fks = await sql<{ name: string; cs: string; child: string; cols: string[]; ps: string; parent: string; refs: string[] }>`
    select con.conname as name, cn.nspname as cs, ch.relname as child, pn.nspname as ps, pa.relname as parent,
      array(select a.attname from unnest(con.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i)::text[] as cols,
      array(select a.attname from unnest(con.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i)::text[] as refs
    from pg_constraint con
      join pg_class ch on ch.oid = con.conrelid join pg_namespace cn on cn.oid = ch.relnamespace
      join pg_class pa on pa.oid = con.confrelid join pg_namespace pn on pn.oid = pa.relnamespace
    where con.contype = 'f' and cn.nspname not in ('pg_catalog', 'information_schema') and cn.nspname not like 'pg\\_%'`.execute(tx);
  for (const fk of fks.rows) {
    // MATCH SIMPLE (the default and the only kind used here): a key with any NULL column references nothing.
    const notNull = sql.join(fk.cols.map((c) => sql`c.${sql.ref(c)} is not null`), sql` and `);
    const match = sql.join(fk.cols.map((c, i) => sql`p.${sql.ref(fk.refs[i]!)} = c.${sql.ref(c)}`), sql` and `);
    const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.id(fk.cs, fk.child)} c where ${notNull} and not exists (select 1 from ${sql.id(fk.ps, fk.parent)} p where ${match})`.execute(tx);
    if (r.rows[0]!.n > 0) throw new Problem(409, 'purge-dangling', `Löschen abgebrochen: ${r.rows[0]!.n} Zeilen in ${fk.cs}.${fk.child} verweisen noch auf gelöschte Daten (${fk.name}). Nichts wurde gelöscht.`);
  }
}
