import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { sql } from 'kysely';
import { audit } from '../audit.ts';
import type { Db } from '../db.ts';
import { orgToday } from '../members/query.ts';
import { deleteChain, deletionBlocker, lockChain } from './chain.ts';
import { Problem } from '../http/problem.ts';

const pathOf = (sha: string) => join(config.filesDir, sha.slice(0, 2), sha);
export const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Stores bytes under their SHA-256; identical bytes are written once. Write-then-rename keeps half files invisible. */
export async function putBlob(bytes: Buffer) {
  const sha = sha256Of(bytes);
  const target = pathOf(sha);
  try {
    await stat(target);
    // Refresh the age so the sweep never removes a blob a running upload is about to reference.
    await utimes(target, new Date(), new Date());
  } catch {
    await mkdir(join(config.filesDir, sha.slice(0, 2)), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }
  return sha;
}

/** Reads bytes back and refuses them when they no longer match their hash. */
export async function getBlob(sha: string) {
  const bytes = await readFile(pathOf(sha)).catch(() => {
    throw new Problem(410, 'file-missing', 'Die Datei ist nicht mehr im Speicher.');
  });
  if (sha256Of(bytes) !== sha) throw new Problem(500, 'integrity', 'Die gespeicherte Datei ist beschädigt (Prüfsumme stimmt nicht).');
  return bytes;
}

/**
 * Deletes temporary documents after 7 days (whole chains, never under hold or retention), then removes blobs no
 * file row points to. Blobs younger than an hour are kept, so an upload whose transaction has not committed yet is
 * never swept: bytes only go once the deleting transaction has committed. One sweep at a time per database.
 */
export async function sweepFiles(db: Db) {
  return db.connection().execute(async (conn) => {
    const lock = await sql<{ ok: boolean }>`select pg_try_advisory_lock(hashtext('openverein:file-sweep')) as ok`.execute(conn);
    if (!lock.rows[0]?.ok) return 0;
    try {
      await expireTemporary(conn);
      return await removeOrphans(conn);
    } finally {
      await sql`select pg_advisory_unlock(hashtext('openverein:file-sweep'))`.execute(conn);
    }
  });
}

async function expireTemporary(db: Db) {
  const heads = await db.selectFrom('file').select(['id', 'organization_id']).where('retention_class', '=', 'temporary').where('superseded_at', 'is', null).where('created_at', '<', new Date(Date.now() - 7 * 86_400_000)).execute();
  for (const h of heads) {
    await db.transaction().execute(async (tx) => {
      const chain = await lockChain(tx, h.id);
      if (!chain || deletionBlocker(chain, await orgToday(tx, h.organization_id))) return;
      await deleteChain(tx, chain);
      await audit(tx, h.organization_id, null, { action: 'file.expired', entityType: 'file', entityId: h.id, diff: { name: [chain[0]!.name, null] } });
    });
  }
}

async function removeOrphans(db: Db) {
  const dirs = await readdir(config.filesDir).catch(() => [] as string[]);
  const hourAgo = Date.now() - 3_600_000;
  let removed = 0;
  for (const dir of dirs) {
    const names = await readdir(join(config.filesDir, dir)).catch(() => [] as string[]);
    // Leftovers of crashed uploads.
    for (const n of names.filter((x) => x.endsWith('.tmp'))) {
      const p = join(config.filesDir, dir, n);
      const age = (await stat(p).catch(() => null))?.mtimeMs;
      if (age !== undefined && age < hourAgo) await rm(p, { force: true });
    }
    const blobs = names.filter((n) => /^[0-9a-f]{64}$/.test(n));
    if (!blobs.length) continue;
    // shortcut: one query per prefix directory and a full directory walk; fine up to ~100k files, upgrade to a blob table beyond.
    const used = new Set((await db.selectFrom('file').select('sha256').distinct().where('sha256', 'in', blobs).execute()).map((r) => r.sha256));
    for (const n of blobs) {
      if (used.has(n)) continue;
      const p = join(config.filesDir, dir, n);
      const st = await stat(p).catch(() => null);
      if (!st || st.mtimeMs > hourAgo) continue;
      // Move aside first, then look again: an upload of the same bytes in between gets its blob back.
      const trash = `${p}.trash`;
      if (!(await rename(p, trash).then(() => true, () => false))) continue;
      const again = await db.selectFrom('file').select('id').where('sha256', '=', n).executeTakeFirst();
      if (again) await rename(trash, p);
      else {
        await rm(trash, { force: true });
        removed++;
      }
    }
  }
  return removed;
}
