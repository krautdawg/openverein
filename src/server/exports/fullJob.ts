import { audit } from '../audit.ts';
import { encryptBytes } from '../crypto.ts';
import { putBlob } from '../files/store.ts';
import { JobError, type JobContext } from '../jobs/job.ts';
import { isClubAdmin } from '../policy.ts';
import { buildFullExport } from './full.ts';

/** The full export as a job: built from one snapshot, stored encrypted, kept 7 days. */
export async function runFullExport({ db, job, actor, progress }: JobContext) {
  if (!isClubAdmin(actor)) throw new JobError('Den Gesamtexport dürfen nur Admins starten. Die Rolle wurde inzwischen entzogen.');
  const { file: plain, manifest } = await buildFullExport(db, job.organization_id, (share) => progress(share * 0.9, 'Daten und Dateien werden gesammelt'));
  await progress(0.9, 'Export wird verschlüsselt gespeichert');
  // Decrypted bank data never rests in plaintext: the stored blob is encrypted with the data key.
  const file = encryptBytes(plain);
  const sha = await putBlob(file);
  const f = await db.transaction().execute(async (tx) => {
    const f = await tx.insertInto('file').values({ organization_id: job.organization_id, folder_id: null, member_id: null, purpose: 'export', sha256: sha, size_bytes: file.length, mime_type: 'application/zip', name: `OpenVerein-Export-${manifest.exportedAt.slice(0, 10)}.zip`, retention_class: 'temporary', retain_until: null, uploaded_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await audit(tx, job.organization_id, actor, { action: 'export.full', entityType: 'file', entityId: f.id, diff: { counts: [null, manifest.counts], sha256: [null, sha] } });
    return f;
  });
  return { fileId: f.id };
}
