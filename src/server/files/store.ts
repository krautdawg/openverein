import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { Db } from '../db.ts';
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
 * Deletes temporary files after 7 days, then removes blobs no file row points to.
 * Blobs younger than an hour are kept, so an upload whose transaction has not committed yet is never swept:
 * bytes only go once the deleting transaction has committed.
 */
export async function sweepFiles(db: Db) {
  await db.deleteFrom('file').where('retention_class', '=', 'temporary').where('legal_hold', '=', false).where('created_at', '<', new Date(Date.now() - 7 * 86_400_000)).execute();
  const dirs = await readdir(config.filesDir).catch(() => [] as string[]);
  let removed = 0;
  for (const dir of dirs) {
    const names = (await readdir(join(config.filesDir, dir)).catch(() => [] as string[])).filter((n) => /^[0-9a-f]{64}$/.test(n));
    if (!names.length) continue;
    // shortcut: one query per prefix directory and a full directory walk; fine up to ~100k files, upgrade to a blob table beyond.
    const used = new Set((await db.selectFrom('file').select('sha256').distinct().where('sha256', 'in', names).execute()).map((r) => r.sha256));
    for (const n of names) {
      if (used.has(n)) continue;
      const p = join(config.filesDir, dir, n);
      if ((await stat(p)).mtimeMs > Date.now() - 3_600_000) continue;
      await rm(p, { force: true });
      removed++;
    }
  }
  return removed;
}
