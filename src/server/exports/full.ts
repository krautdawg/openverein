import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { decrypt } from '../crypto.ts';
import type { Db } from '../db.ts';
import { getBlob } from '../files/store.ts';
import { MIGRATIONS_TABLE } from '../migrate.ts';
import { zip } from './zip.ts';

/** Bumped whenever the shape of the export changes; documented in docs/export-schema.md. */
export const EXPORT_SCHEMA_VERSION = '1';

/** Sign-in secrets and live sessions never leave the instance. */
const SKIP_TABLES = new Set(['session', 'portal_session', 'login_code', 'totp_recovery_code', 'idempotency_key', MIGRATIONS_TABLE]);
/** Credentials, tokens and keyed hashes are dropped; they are useless elsewhere and dangerous in a file. */
const DROP_COLUMN = /^(password_hash|invite_token_hash|token_hash|feed_token_hash|token_mac|code_hash|email_hash|iban_hash|counterparty_iban_hash|totp_secret_encrypted|totp_pending_secret_encrypted|totp_last_step)$/;
/** Tables without organization_id, exported through their parent. */
const CHILDREN: Record<string, { parent: string; key: string }> = {
  receipt_line: { parent: 'receipt', key: 'receipt_id' },
  donation_receipt_item: { parent: 'donation_receipt', key: 'receipt_id' },
  datev_export_entry: { parent: 'datev_export', key: 'export_id' },
  household_rule: { parent: 'household', key: 'household_id' },
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Plain values for JSON: dates as ISO strings, bytes as base64, encrypted columns decrypted under their plain name. */
function clean(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (DROP_COLUMN.test(k)) continue;
    if (k.endsWith('_encrypted')) {
      let plain: string | null = null;
      if (typeof v === 'string' && v) {
        try {
          plain = decrypt(v);
        } catch {
          plain = null;
        }
      }
      out[k.slice(0, -'_encrypted'.length)] = plain;
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
export async function buildFullExport(db: Db, organizationId: string) {
  const tables = (await sql<{ t: string; has_org: boolean }>`
    select t.table_name as t, exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'organization_id') as has_org
    from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' order by 1`.execute(db)).rows;
  const entries: { name: string; data: Buffer }[] = [];
  const counts: Record<string, number> = {};
  for (const { t, has_org } of tables) {
    if (SKIP_TABLES.has(t)) continue;
    let rows: Record<string, unknown>[];
    if (t === 'organization') rows = (await sql<Record<string, unknown>>`select * from organization where id = ${organizationId}`.execute(db)).rows;
    else if (has_org) rows = (await sql<Record<string, unknown>>`select * from ${sql.table(t)} where organization_id = ${organizationId} order by 1`.execute(db)).rows;
    else if (CHILDREN[t]) {
      const { parent, key } = CHILDREN[t];
      rows = (await sql<Record<string, unknown>>`select c.* from ${sql.table(t)} c join ${sql.table(parent)} p on p.id = c.${sql.ref(key)} where p.organization_id = ${organizationId}`.execute(db)).rows;
    } else continue;
    const cleaned = rows.map(clean);
    counts[t] = cleaned.length;
    const columns = [...new Set(cleaned.flatMap((r) => Object.keys(r)))];
    entries.push({ name: `data/${t}.jsonl`, data: Buffer.from(cleaned.map((r) => JSON.stringify(r)).join('\n') + (cleaned.length ? '\n' : ''), 'utf8') });
    // CSV for spreadsheets: same rows, bytes left out (they are in the JSONL).
    const csvCols = columns.filter((c) => !cleaned.some((r) => r[c] && typeof r[c] === 'object' && 'base64' in (r[c] as object)));
    entries.push({ name: `data/${t}.csv`, data: Buffer.from('﻿' + [csvCols.join(';'), ...cleaned.map((r) => csvCols.map((c) => csvCell(r[c])).join(';'))].join('\r\n') + '\r\n', 'utf8') });
  }
  // Stored files once per content hash; deleted or missing blobs are listed, not fatal.
  const blobs = await db.selectFrom('file').select('sha256').distinct().where('organization_id', '=', organizationId).where('purpose', '<>', 'export').execute();
  const missing: string[] = [];
  for (const { sha256 } of blobs) {
    try {
      entries.push({ name: `files/${sha256}`, data: await getBlob(sha256) });
    } catch {
      missing.push(sha256);
    }
  }
  const last = (await sql<{ name: string }>`select name from ${sql.table(MIGRATIONS_TABLE)} order by name desc limit 1`.execute(db)).rows[0]?.name ?? null;
  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    organizationId,
    databaseVersion: last,
    counts,
    missingFiles: missing,
    files: Object.fromEntries(entries.map((e) => [e.name, sha(e.data)])),
  };
  const file = zip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }, ...entries]);
  return { file, manifest };
}
