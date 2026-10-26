import { audit } from '../audit.ts';
import { encryptBytes } from '../crypto.ts';
import { putBlob } from '../files/store.ts';
import { JobError, type JobContext } from '../jobs/job.ts';
import { isClubAdmin } from '../policy.ts';
import { buildFullExport } from './full.ts';
import { lockErasures } from '../gdpr/service.ts';
import { sql } from 'kysely';

/** The full export as a job: built from one snapshot, stored encrypted, kept 7 days. */
export async function runFullExport({ db, job, actor, progress, owned }: JobContext) {
  if (!isClubAdmin(actor)) throw new JobError('Den Gesamtexport dürfen nur Admins starten. Die Rolle wurde inzwischen entzogen.');
  const started = (await sql<{ t: Date }>`select now() as t`.execute(db)).rows[0]!.t;
  const { file: plain, manifest } = await buildFullExport(db, job.organization_id, (share) => progress(share * 0.9, 'Daten und Dateien werden gesammelt'));
  await progress(0.9, 'Export wird verschlüsselt gespeichert');
  // Decrypted bank data never rests in plaintext: the stored blob is encrypted with the data key.
  const file = encryptBytes(plain);
  const sha = await putBlob(file);
  const f = await db.transaction().execute(async (tx) => {
    await owned(tx);
    // An erasure during the export would come back with it: same lock as anonymise, then check for erasures since the start.
    await lockErasures(tx, job.organization_id);
    const erased = await tx.selectFrom('erasure_log').select('id').where('organization_id', '=', job.organization_id).where('at', '>=', started).executeTakeFirst();
    if (erased) throw new JobError('Während des Exports wurde eine Person anonymisiert. Starte den Export neu, damit sie darin nicht mehr vorkommt.');
    const f = await tx.insertInto('file').values({ organization_id: job.organization_id, folder_id: null, member_id: null, purpose: 'export', sha256: sha, size_bytes: file.length, mime_type: 'application/zip', name: `OpenVerein-Export-${manifest.exportedAt.slice(0, 10)}.zip`, retention_class: 'temporary', retain_until: null, uploaded_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await audit(tx, job.organization_id, actor, { action: 'export.full', entityType: 'file', entityId: f.id, diff: { counts: [null, manifest.counts], sha256: [null, sha] } });
    return f;
  });
  return { fileId: f.id };
}
