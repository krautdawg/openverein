import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { decrypt, decryptBytes } from '../crypto.ts';
import type { Db } from '../db.ts';
import { getBlob } from '../files/store.ts';
import { MIGRATIONS_TABLE } from '../migrate.ts';
import { Problem } from '../http/problem.ts';
import { zip } from './zip.ts';

/** Bumped whenever the shape of the export changes; documented in docs/export-schema.md. */
export const EXPORT_SCHEMA_VERSION = '2';

/** Sign-in secrets and live sessions never leave the instance. */
const SKIP_TABLES = new Set(['session', 'portal_session', 'login_code', 'portal_verify_failure', 'totp_recovery_code', 'idempotency_key', 'instance_setting', 'operator_event', MIGRATIONS_TABLE]);
/** Credentials, tokens and keyed hashes are dropped; they are useless elsewhere and dangerous in a file. */
const DROP_COLUMN = /^(password_hash|invite_token_hash|token_hash|feed_token_hash|token_mac|code_hash|email_hash|iban_hash|counterparty_iban_hash|totp_secret_encrypted|totp_pending_secret_encrypted|totp_last_step|secret_encrypted|oidc_client_secret_encrypted)$/;
/** Tables without organization_id, exported through their parent. */
export const CHILDREN: Record<string, { parent: string; key: string }> = {
  receipt_line: { parent: 'receipt', key: 'receipt_id' },
  donation_receipt_item: { parent: 'donation_receipt', key: 'receipt_id' },
  datev_export_entry: { parent: 'datev_export', key: 'export_id' },
  household_rule: { parent: 'household', key: 'household_id' },
  assembly_item: { parent: 'assembly', key: 'assembly_id' },
  assembly_attendance: { parent: 'assembly', key: 'assembly_id' },
  poll_vote: { parent: 'poll', key: 'poll_id' },
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formula guard for text only: negative amounts stay numbers.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * Plain values for JSON: dates as ISO strings, bytes as base64, encrypted columns decrypted under their plain name.
 * Values that cannot be decrypted are counted (manifest `undecryptable`), never silently dropped.
 */
function clean(table: string, row: Record<string, unknown>, failed: Record<string, number>) {
  const tryDecrypt = (column: string, v: unknown) => {
    if (typeof v !== 'string' || !v) return null;
    try {
      return decrypt(v);
    } catch {
      failed[`${table}.${column}`] = (failed[`${table}.${column}`] ?? 0) + 1;
      return null;
    }
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (DROP_COLUMN.test(k)) continue;
    if (k.endsWith('_encrypted')) {
      out[k.slice(0, -'_encrypted'.length)] = tryDecrypt(k, v);
      continue;
    }
    // Bank changes from the portal keep both values encrypted in the generic value columns.
    if (table === 'change_request' && row.field === 'iban' && (k === 'old_value' || k === 'new_value') && typeof v === 'string' && v.startsWith('v1:')) {
      out[k] = tryDecrypt(k, v);
      continue;
    }
    // The issued XRechnung is stored encrypted without the `_encrypted` suffix: exported as the readable XML.
    if (table === 'invoice_einvoice' && k === 'xml' && Buffer.isBuffer(v)) {
      try {
        out[k] = decryptBytes(v).toString('utf8');
      } catch {
        failed[`${table}.${k}`] = (failed[`${table}.${k}`] ?? 0) + 1;
        out[k] = null;
      }
      continue;
    }
    out[k] = v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? { base64: v.toString('base64') } : v;
  }
  return out;
}

/**
 * Everything of one club as a ZIP: per table `data/<table>.jsonl` and `data/<table>.csv`, the stored files under
 * `files/<sha256>`, and `manifest.json` with schema version, counts and the SHA-256 of every other file.
 */
/** onProgress gets the share done (0–1); it runs outside the snapshot transaction. */
export async function buildFullExport(db: Db, organizationId: string, onProgress?: (share: number) => Promise<void>) {
  // One consistent snapshot: no invoice lines without their invoice because something was booked meanwhile.
  return db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute((tx) => build(tx, organizationId, onProgress));
}

async function build(db: Db, organizationId: string, onProgress?: (share: number) => Promise<void>) {
  const columnsOf = new Map<string, string[]>();
  for (const c of (await sql<{ t: string; c: string }>`select table_name as t, column_name as c from information_schema.columns where table_schema = 'public' order by ordinal_position`.execute(db)).rows) columnsOf.set(c.t, [...(columnsOf.get(c.t) ?? []), c.c]);
  const failed: Record<string, number> = {};
  const tables = (await sql<{ t: string; has_org: boolean }>`
    select t.table_name as t, exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'organization_id') as has_org
    from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' order by 1`.execute(db)).rows;
  const entries: { name: string; data: Buffer }[] = [];
  const counts: Record<string, number> = {};
  for (const [i, { t, has_org }] of tables.entries()) {
    if (SKIP_TABLES.has(t)) continue;
    if (i % 8 === 0) await onProgress?.((i / tables.length) * 0.8);
    let rows: Record<string, unknown>[];
    if (t === 'organization') rows = (await sql<Record<string, unknown>>`select * from organization where id = ${organizationId}`.execute(db)).rows;
    else if (has_org) rows = (await sql<Record<string, unknown>>`select * from ${sql.table(t)} where organization_id = ${organizationId} order by 1`.execute(db)).rows;
    else if (CHILDREN[t]) {
      const { parent, key } = CHILDREN[t];
      rows = (await sql<Record<string, unknown>>`select c.* from ${sql.table(t)} c join ${sql.table(parent)} p on p.id = c.${sql.ref(key)} where p.organization_id = ${organizationId}`.execute(db)).rows;
    } else throw new Error(`full export: table ${t} has no organization_id and no parent; add it to CHILDREN or SKIP_TABLES`);
    const cleaned = rows.map((r) => clean(t, r, failed));
    counts[t] = cleaned.length;
    // Header from the schema, so empty tables still say what they would hold.
    const columns = (columnsOf.get(t) ?? []).filter((c) => !DROP_COLUMN.test(c)).map((c) => (c.endsWith('_encrypted') ? c.slice(0, -'_encrypted'.length) : c));
    entries.push({ name: `data/${t}.jsonl`, data: Buffer.from(cleaned.map((r) => JSON.stringify(r)).join('\n') + (cleaned.length ? '\n' : ''), 'utf8') });
    // CSV for spreadsheets: same rows, bytes left out (they are in the JSONL).
    const csvCols = columns.filter((c) => !cleaned.some((r) => r[c] && typeof r[c] === 'object' && 'base64' in (r[c] as object)));
    entries.push({ name: `data/${t}.csv`, data: Buffer.from('﻿' + [csvCols.join(';'), ...cleaned.map((r) => csvCols.map((c) => csvCell(r[c])).join(';'))].join('\r\n') + '\r\n', 'utf8') });
  }
  // Stored files once per content hash; deleted or missing blobs are listed, not fatal.
  const blobs = await db.selectFrom('file').select('sha256').distinct().where('organization_id', '=', organizationId).where('purpose', '<>', 'export').execute();
  const missing: string[] = [];
  const corrupt: string[] = [];
  await onProgress?.(0.8);
  for (const { sha256 } of blobs) {
    try {
      entries.push({ name: `files/${sha256}`, data: await getBlob(sha256) });
    } catch (err) {
      (err instanceof Problem && err.type === 'integrity' ? corrupt : missing).push(sha256);
    }
  }
  // shortcut: built in memory without ZIP64 (65,535 entries, 4 GB); stream with ZIP64 once a club's file store gets that big.
  if (entries.length + 1 > 65_535) throw new Problem(413, 'too-large', 'Der Export ist für diese Version zu groß (über 65.535 Dateien).');
  const last = (await sql<{ name: string }>`select name from ${sql.table(MIGRATIONS_TABLE)} order by name desc limit 1`.execute(db)).rows[0]?.name ?? null;
  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    organizationId,
    databaseVersion: last,
    counts,
    missingFiles: missing,
    corruptFiles: corrupt,
    undecryptable: failed,
    files: Object.fromEntries(entries.map((e) => [e.name, sha(e.data)])),
  };
  const file = zip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }, ...entries]);
  return { file, manifest };
}
