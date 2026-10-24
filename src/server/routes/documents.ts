import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { fileDto, filePatch, folder, folderInput, MAX_FILE_BYTES } from '../../shared/documents.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { FileTable, FolderTable, RetentionClass } from '../db.ts';
import { getBlob, putBlob } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { loadMemberRow, orgToday } from '../members/query.ts';
import { requirePermission, scopeOf, type Actor } from '../policy.ts';

const tags = ['documents'];
const idParam = z.object({ id: z.uuid() });
type FolderRow = Selectable<FolderTable>;
type FileRow = Selectable<FileTable>;

const addYears = (date: string, n: number) => `${Number(date.slice(0, 4)) + n}${date.slice(4)}`;
// Vouchers (Buchungsbelege) are kept 8 years after the end of the calendar year (§ 147 AO, § 257 HGB).
const retainUntil = (cls: RetentionClass, today: string) => (cls === 'voucher' ? addYears(`${today.slice(0, 4)}-12-31`, 8) : null);

/** Effective access of a folder: its own groups, else its parent's; null means everyone with documents access. */
export function effectiveGroups(folders: FolderRow[], id: string | null): string[] | null {
  for (let f = folders.find((x) => x.id === id), depth = 0; f && depth < 50; f = folders.find((x) => x.id === f!.parent_id), depth++) {
    if (f.group_ids) return f.group_ids;
  }
  return null;
}

export const documentRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  // Uploads send raw bytes. application/octet-stream is not a CORS-simple type, so a cross-site form cannot send it;
  // the origin check in app.ts still applies.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES }, (_req, body, done) => done(null, body));

  const allFolders = (actor: Actor) => db.selectFrom('folder').selectAll().where('organization_id', '=', actor.organizationId).orderBy('name').execute();
  const allowed = (actor: Actor, mode: 'read' | 'write', groups: string[] | null) => {
    const scope = scopeOf(actor, 'documents', mode);
    return scope === null || groups === null || groups.some((g) => scope.includes(g));
  };

  async function folderFor(actor: Actor, id: string, mode: 'read' | 'write') {
    const folders = await allFolders(actor);
    const f = folders.find((x) => x.id === id);
    if (!f || !allowed(actor, 'read', effectiveGroups(folders, id))) throw notFound('Ordner');
    if (mode === 'write' && !allowed(actor, 'write', effectiveGroups(folders, id))) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'In diesen Ordner darfst Du nichts ablegen.', { permission: 'documents:write' });
    return f;
  }

  /** Checks access to where a file lives: a member's record or a folder (top level = documents module). */
  async function assertPlace(actor: Actor, place: { folder_id: string | null; member_id: string | null }, mode: 'read' | 'write') {
    if (place.member_id) {
      requirePermission(actor, 'members', mode);
      await loadMemberRow(db, actor, place.member_id, mode);
      return;
    }
    requirePermission(actor, 'documents', mode);
    if (place.folder_id) await folderFor(actor, place.folder_id, mode);
    else if (mode === 'write' && scopeOf(actor, 'documents', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Leg die Datei in einen Ordner Deiner Gruppe.', { permission: 'documents:write (ganzer Verein)' });
  }

  async function loadFile(actor: Actor, id: string, mode: 'read' | 'write') {
    const f = await db.selectFrom('file').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!f) throw notFound('Datei');
    await assertPlace(actor, f, mode);
    return f;
  }

  async function dtos(rows: FileRow[]) {
    if (!rows.length) return [];
    const users = await db.selectFrom('app_user').select(['id', 'name']).where('id', 'in', rows.map((r) => r.uploaded_by).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000'])).execute();
    // Version number = length of the chain of previous files.
    const versions = await sql<{ id: string; n: number }>`
      with recursive chain(id, prev, n, start) as (
        select id, previous_id, 1, id from file where id = any(${rows.map((r) => r.id)}::uuid[])
        union all select c.id, f.previous_id, c.n + 1, c.start from chain c join file f on f.id = c.prev
      ) select start as id, max(n)::int as n from chain group by start`.execute(db);
    return rows.map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      memberId: r.member_id,
      name: r.name,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      sha256: r.sha256,
      retentionClass: r.retention_class,
      retainUntil: r.retain_until,
      legalHold: r.legal_hold,
      version: versions.rows.find((v) => v.id === r.id)?.n ?? 1,
      uploadedBy: users.find((u) => u.id === r.uploaded_by)?.name ?? null,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // ---------- Folders ----------

  const folderDto = (folders: FolderRow[], f: FolderRow) => ({ id: f.id, parentId: f.parent_id, name: f.name, groupIds: f.group_ids, restricted: effectiveGroups(folders, f.id) !== null });

  app.get('/folders', { schema: { tags, summary: 'Ordner, die Du sehen darfst', response: { 200: z.array(folder) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'documents', 'read');
    const folders = await allFolders(actor);
    return folders.filter((f) => allowed(actor, 'read', effectiveGroups(folders, f.id))).map((f) => folderDto(folders, f));
  });

  const unscoped = (actor: Actor) => {
    if (scopeOf(actor, 'documents', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Ordner verwalten Zugänge für den ganzen Verein.', { permission: 'documents:write (ganzer Verein)' });
  };

  app.post('/folders', { schema: { tags, summary: 'Ordner anlegen', body: folderInput, response: { 201: folder } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'documents', 'write');
    unscoped(actor);
    if (req.body.parentId) await folderFor(actor, req.body.parentId, 'write');
    const f = await db.transaction().execute(async (tx) => {
      const f = await tx.insertInto('folder').values({ organization_id: actor.organizationId, parent_id: req.body.parentId ?? null, name: req.body.name, group_ids: req.body.groupIds?.length ? req.body.groupIds : null }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'folder.created', entityType: 'folder', entityId: f.id, diff: { name: [null, f.name] } });
      return f;
    });
    reply.status(201);
    return folderDto(await allFolders(actor), f);
  });

  app.patch('/folders/:id', { schema: { tags, summary: 'Ordner umbenennen, verschieben oder Zugriff ändern', params: idParam, body: folderInput.partial(), response: { 200: folder } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'documents', 'write');
    unscoped(actor);
    const before = await folderFor(actor, req.params.id, 'write');
    const folders = await allFolders(actor);
    if (req.body.parentId) {
      // No folder may end up inside itself.
      for (let p: FolderRow | undefined = folders.find((x) => x.id === req.body.parentId); p; p = folders.find((x) => x.id === p!.parent_id)) {
        if (p.id === before.id) throw new Problem(409, 'cycle', 'Ein Ordner kann nicht in sich selbst liegen.');
      }
    }
    const f = await db.transaction().execute(async (tx) => {
      const f = await tx
        .updateTable('folder')
        .set({
          ...(req.body.name ? { name: req.body.name } : {}),
          ...(req.body.parentId !== undefined ? { parent_id: req.body.parentId ?? null } : {}),
          ...(req.body.groupIds !== undefined ? { group_ids: req.body.groupIds?.length ? req.body.groupIds : null } : {}),
        })
        .where('id', '=', before.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'folder.updated', entityType: 'folder', entityId: f.id, diff: { name: [before.name, f.name], groupIds: [before.group_ids, f.group_ids] } });
      return f;
    });
    return folderDto(await allFolders(actor), f);
  });

  app.delete('/folders/:id', { schema: { tags, summary: 'Leeren Ordner löschen', params: idParam, response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'documents', 'write');
    unscoped(actor);
    const f = await folderFor(actor, req.params.id, 'write');
    await db.transaction().execute(async (tx) => {
      const used = await tx.selectFrom('file').select('id').where('folder_id', '=', f.id).union(tx.selectFrom('folder').select('id').where('parent_id', '=', f.id)).executeTakeFirst();
      if (used) throw new Problem(409, 'not-empty', 'Der Ordner ist nicht leer.', 'Verschieb oder lösch zuerst die Dateien und Unterordner.');
      await tx.deleteFrom('folder').where('id', '=', f.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'folder.deleted', entityType: 'folder', entityId: f.id, diff: { name: [f.name, null] } });
    });
    reply.status(204);
    return null;
  });

  // ---------- Files ----------

  app.get(
    '/files',
    { schema: { tags, summary: 'Dateien in einem Ordner (ohne Angabe: oberste Ebene) oder bei einem Mitglied', querystring: z.object({ folderId: z.uuid().optional(), memberId: z.uuid().optional() }), response: { 200: z.array(fileDto) } } },
    async (req) => {
      const actor = requireActor(req);
      const place = { folder_id: req.query.folderId ?? null, member_id: req.query.memberId ?? null };
      if (place.folder_id && place.member_id) throw new Problem(400, 'validation', 'Entweder Ordner oder Mitglied.');
      await assertPlace(actor, place, 'read');
      let q = db.selectFrom('file').selectAll().where('organization_id', '=', actor.organizationId).where('superseded_at', 'is', null);
      q = place.member_id ? q.where('member_id', '=', place.member_id) : q.where('member_id', 'is', null).where('folder_id', place.folder_id ? '=' : 'is', place.folder_id);
      return dtos(await q.orderBy('name').execute());
    },
  );

  const uploadQuery = z.object({
    name: z.string().trim().min(1).max(255),
    folderId: z.uuid().optional(),
    memberId: z.uuid().optional(),
    retentionClass: z.enum(['document', 'voucher', 'temporary']).default('document'),
  });

  function bytesOf(body: unknown) {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new Problem(400, 'empty', 'Die Datei ist leer.');
    return body;
  }
  const mimeOf = (req: { headers: Record<string, string | string[] | undefined> }) => String(req.headers['x-file-type'] ?? 'application/octet-stream').slice(0, 100).replace(/[^\w.+/-]/g, '') || 'application/octet-stream';

  app.post(
    '/files',
    {
      schema: {
        tags,
        summary: 'Datei hochladen (Body: die Bytes als application/octet-stream, höchstens 20 MB; Dateityp im Header X-File-Type)',
        querystring: uploadQuery,
        consumes: ['application/octet-stream'],
        response: { 201: fileDto },
      },
    },
    async (req, reply) => {
      const actor = requireActor(req);
      const q = req.query;
      if (q.folderId && q.memberId) throw new Problem(400, 'validation', 'Entweder Ordner oder Mitglied.');
      await assertPlace(actor, { folder_id: q.folderId ?? null, member_id: q.memberId ?? null }, 'write');
      const bytes = bytesOf(req.body);
      const sha = await putBlob(bytes);
      const today = await orgToday(db, actor.organizationId);
      const f = await db.transaction().execute(async (tx) => {
        const f = await tx
          .insertInto('file')
          .values({ organization_id: actor.organizationId, folder_id: q.folderId ?? null, member_id: q.memberId ?? null, sha256: sha, size_bytes: bytes.length, mime_type: mimeOf(req), name: q.name, retention_class: q.retentionClass, retain_until: retainUntil(q.retentionClass, today), uploaded_by: actor.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor.organizationId, actor, { action: 'file.uploaded', entityType: 'file', entityId: f.id, diff: { name: [null, f.name], sha256: [null, sha], member: [null, f.member_id] } });
        return f;
      });
      reply.status(201);
      return (await dtos([f]))[0]!;
    },
  );

  app.post(
    '/files/:id/versions',
    { schema: { tags, summary: 'Neue Fassung hochladen; die bisherige bleibt als ältere Version abrufbar', params: idParam, consumes: ['application/octet-stream'], response: { 201: fileDto } } },
    async (req, reply) => {
      const actor = requireActor(req);
      const old = await loadFile(actor, req.params.id, 'write');
      if (old.superseded_at) throw new Problem(409, 'superseded', 'Das ist schon eine ältere Version. Lade die neue Fassung bei der aktuellen hoch.');
      const bytes = bytesOf(req.body);
      const sha = await putBlob(bytes);
      const today = await orgToday(db, actor.organizationId);
      const f = await db.transaction().execute(async (tx) => {
        const locked = await tx.updateTable('file').set({ superseded_at: new Date() }).where('id', '=', old.id).where('superseded_at', 'is', null).returning('id').executeTakeFirst();
        if (!locked) throw new Problem(409, 'superseded', 'Jemand hat gerade eine neue Fassung hochgeladen.');
        const f = await tx
          .insertInto('file')
          .values({ organization_id: actor.organizationId, folder_id: old.folder_id, member_id: old.member_id, sha256: sha, size_bytes: bytes.length, mime_type: mimeOf(req), name: old.name, retention_class: old.retention_class, retain_until: retainUntil(old.retention_class, today), legal_hold: old.legal_hold, previous_id: old.id, uploaded_by: actor.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor.organizationId, actor, { action: 'file.version_uploaded', entityType: 'file', entityId: f.id, diff: { previous: [null, old.id], sha256: [old.sha256, sha] } });
        return f;
      });
      reply.status(201);
      return (await dtos([f]))[0]!;
    },
  );

  app.get('/files/:id/versions', { schema: { tags, summary: 'Alle Fassungen einer Datei, neueste zuerst', params: idParam, response: { 200: z.array(fileDto) } } }, async (req) => {
    const actor = requireActor(req);
    const f = await loadFile(actor, req.params.id, 'read');
    const chain: FileRow[] = [f];
    for (let prev = f.previous_id; prev && chain.length < 500; ) {
      const p = await db.selectFrom('file').selectAll().where('id', '=', prev).executeTakeFirst();
      if (!p) break;
      chain.push(p);
      prev = p.previous_id;
    }
    return dtos(chain);
  });

  app.get('/files/:id/content', { schema: { tags, summary: 'Datei herunterladen (die gespeicherten Bytes, mit Prüfsummenkontrolle)', params: idParam, querystring: z.object({ inline: z.coerce.boolean().optional() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    const f = await loadFile(actor, req.params.id, 'read');
    const bytes = await getBlob(f.sha256);
    // Only PDFs and raster images may render inline; everything else downloads, never sniffed, never scripted.
    const inline = req.query.inline && /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(f.mime_type);
    return reply
      .header('content-type', inline ? f.mime_type : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store')
      .send(bytes);
  });

  app.patch('/files/:id', { schema: { tags, summary: 'Datei umbenennen, verschieben, Aufbewahrung oder Sperre ändern', params: idParam, body: filePatch, response: { 200: fileDto } } }, async (req) => {
    const actor = requireActor(req);
    const f = await loadFile(actor, req.params.id, 'write');
    const b = req.body;
    if (b.folderId !== undefined) {
      if (f.member_id) throw new Problem(409, 'member-file', 'Dateien eines Mitglieds bleiben beim Mitglied.');
      await assertPlace(actor, { folder_id: b.folderId, member_id: null }, 'write');
    }
    if (b.legalHold !== undefined && scopeOf(actor, 'documents', 'write') !== null) unscoped(actor);
    const today = await orgToday(db, actor.organizationId);
    // A shorter retention class never shortens a running retention period.
    const until = b.retentionClass ? [f.retain_until, retainUntil(b.retentionClass, today)].filter((x): x is string => !!x).sort().at(-1) ?? null : f.retain_until;
    const updated = await db.transaction().execute(async (tx) => {
      const u = await tx
        .updateTable('file')
        .set({ ...(b.name ? { name: b.name } : {}), ...(b.folderId !== undefined ? { folder_id: b.folderId } : {}), ...(b.retentionClass ? { retention_class: b.retentionClass, retain_until: until } : {}), ...(b.legalHold !== undefined ? { legal_hold: b.legalHold } : {}) })
        .where('id', '=', f.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'file.updated', entityType: 'file', entityId: f.id, diff: { name: [f.name, u.name], folder: [f.folder_id, u.folder_id], retention: [f.retention_class, u.retention_class], legalHold: [f.legal_hold, u.legal_hold] } });
      return u;
    });
    return (await dtos([updated]))[0]!;
  });

  app.delete('/files/:id', { schema: { tags, summary: 'Datei mit allen Fassungen löschen (nicht bei Sperre oder laufender Aufbewahrungsfrist)', params: idParam, response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    const f = await loadFile(actor, req.params.id, 'write');
    const today = await orgToday(db, actor.organizationId);
    await db.transaction().execute(async (tx) => {
      const chain = await sql<FileRow>`
        with recursive chain as (select * from file where id = ${f.id} union all select f.* from file f join chain c on f.id = c.previous_id)
        select * from chain for update`.execute(tx);
      for (const v of chain.rows) {
        if (v.legal_hold) throw new Problem(409, 'legal-hold', 'Für diese Datei gilt eine Löschsperre.');
        if (v.retain_until && v.retain_until > today) throw new Problem(409, 'retention', `Diese Datei ist ein Beleg und muss bis ${v.retain_until.split('-').reverse().join('.')} aufbewahrt werden.`);
      }
      // Newest first, so no row still points at a deleted predecessor. Bytes go later in the sweep, after commit.
      for (const v of chain.rows) await tx.deleteFrom('file').where('id', '=', v.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'file.deleted', entityType: 'file', entityId: f.id, diff: { name: [f.name, null], versions: [chain.rows.length, null] } });
    });
    reply.status(204);
    return null;
  });
};
