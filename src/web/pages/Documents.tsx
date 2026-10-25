import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ChevronRight, FileText, Folder as FolderIcon, Lock, Upload } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { RETENTION_LABEL, type FileDto, type Folder } from '../../shared/documents.ts';
import { Field } from '../components/Field.tsx';
import { InlineEdit } from '../components/InlineEdit.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { DocumentsNav } from './Inventory.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError, uploadAll, uploadFile } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

const date = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

export function Documents({ me }: { me: Me }) {
  useTitle('Dokumente');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { id: fileId } = useParams();
  const [params] = useSearchParams();
  const folderId = params.get('ordner') ?? undefined;
  const canWrite = me.permissions.documents === 'write';
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => api<Folder[]>('/folders') });
  const files = useQuery({ queryKey: ['files', folderId ?? 'root'], queryFn: () => api<FileDto[]>(`/files${folderId ? `?folderId=${folderId}` : ''}`) });
  const [creating, setCreating] = useState(false);
  const [access, setAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const current = folders.data?.find((f) => f.id === folderId);
  const trail: Folder[] = [];
  for (let f = current, depth = 0; f && depth < 100; f = folders.data?.find((x) => x.id === f!.parentId), depth++) trail.unshift(f);
  const children = folders.data?.filter((f) => (f.parentId ?? undefined) === folderId) ?? [];
  const open = (id?: string) => navigate(id ? `/dokumente?ordner=${id}` : '/dokumente');

  async function upload(list: FileList | File[]) {
    if (!list.length) return;
    setBusy(true);
    setError(await uploadAll(list, { folderId }));
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ['files'] });
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (canWrite) void upload(e.dataTransfer.files);
  }

  return (
    <div className="page" onDragOver={(e) => { e.preventDefault(); if (canWrite) setDragging(true); }} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={onDrop}>
      <PageHead
        title="Dokumente"
        intro="Satzung, Protokolle, Formulare. Ordner lassen sich auf Gruppen beschränken; Belege bleiben acht Jahre gesperrt."
        actions={canWrite && (
          <>
            <button className="btn" onClick={() => setCreating(true)}>Ordner anlegen</button>
            <button className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => input.current?.click()}><Upload size={16} aria-hidden /> Hochladen</button>
            <input ref={input} type="file" multiple hidden onChange={(e) => { void upload(e.target.files ?? []); e.target.value = ''; }} />
          </>
        )}
      />

      <DocumentsNav />
      <nav className="crumbs" aria-label="Ordnerpfad">
        {trail.length ? <button className="linklike" onClick={() => open()}>Alle Dokumente</button> : <span aria-current="page">Alle Dokumente</span>}
        {trail.map((f, i) => (
          <span key={f.id}>
            <ChevronRight size={14} aria-hidden />
            {i === trail.length - 1 ? <span aria-current="page">{f.name}</span> : <button className="linklike" onClick={() => open(f.id)}>{f.name}</button>}
          </span>
        ))}
        {current && canWrite && <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setAccess(true)}>{current.restricted ? <><Lock size={14} aria-hidden /> Zugriff</> : 'Zugriff'}</button>}
      </nav>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="table-wrap drop" data-dragging={dragging}>
        {files.data && children.length === 0 && files.data.length === 0 ? (
          <div className="empty-state">
            <h3>{current ? 'Dieser Ordner ist leer.' : 'Noch keine Dokumente.'}</h3>
            <p>{canWrite ? 'Zieh Dateien hierher oder nutze „Hochladen“. Bis 20 MB je Datei.' : 'Hier erscheinen Dateien, sobald jemand sie ablegt.'}</p>
          </div>
        ) : (
          <table className="table" aria-label={current ? `Ordner ${current.name}` : 'Dokumente'}>
            <thead><tr><th scope="col">Name</th><th scope="col" className="hide-sm">Aufbewahrung</th><th scope="col" className="num hide-sm">Größe</th><th scope="col" className="num">Geändert</th></tr></thead>
            <tbody>
              {children.map((f) => (
                <tr key={f.id} data-href tabIndex={0} onClick={() => open(f.id)} onKeyDown={(e) => e.key === 'Enter' && open(f.id)}>
                  <td><span className="file-name"><FolderIcon size={16} aria-hidden /> <span className="name">{f.name}</span>{f.restricted && <Lock size={12} aria-label="eingeschränkt" />}</span></td>
                  <td className="hide-sm" /><td className="hide-sm" /><td />
                </tr>
              ))}
              {files.data?.map((f) => (
                <tr key={f.id} data-href tabIndex={0} aria-selected={f.id === fileId} onClick={() => navigate(`/dokumente/${f.id}${folderId ? `?ordner=${folderId}` : ''}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/dokumente/${f.id}${folderId ? `?ordner=${folderId}` : ''}`)}>
                  <td><span className="file-name"><FileText size={16} aria-hidden /> <span className="name">{f.name}</span>{f.version > 1 && <span className="meta">v{f.version}</span>}{f.legalHold && <Lock size={12} aria-label="Löschsperre" />}</span></td>
                  <td className="hide-sm">{f.retentionClass === 'document' ? '' : RETENTION_LABEL[f.retentionClass].split(' (')[0]}</td>
                  <td className="num hide-sm">{bytes(f.sizeBytes)}</td>
                  <td className="num">{date(f.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {dragging && <p className="meta" role="status">Loslassen zum Hochladen{current ? ` in „${current.name}“` : ''}.</p>}

      {creating && <FolderSheet parent={current} onClose={() => setCreating(false)} />}
      {access && current && <FolderSheet folder={current} onClose={() => setAccess(false)} />}
      <FileSheet id={fileId ?? null} folders={folders.data ?? []} canWrite={canWrite} canHold={canWrite} onClose={() => navigate(folderId ? `/dokumente?ordner=${folderId}` : '/dokumente')} onOpen={(nid) => navigate(`/dokumente/${nid}${folderId ? `?ordner=${folderId}` : ''}`, { replace: true })} />
    </div>
  );
}

function FolderSheet({ folder, parent, onClose }: { folder?: Folder; parent?: Folder; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: groups } = useGroups();
  const [error, setError] = useState<ApiError>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ids = f.getAll('groups');
    setError(undefined);
    try {
      const body = { name: f.get('name'), groupIds: ids.length ? ids : null, shareWithMembers: f.get('share') === 'on' };
      const saved = folder ? await api<Folder>(`/folders/${folder.id}`, { method: 'PATCH', body }) : await api<Folder>('/folders', { method: 'POST', body: { ...body, parentId: parent?.id ?? null } });
      await qc.invalidateQueries({ queryKey: ['folders'] });
      onClose();
      if (!folder) navigate(`/dokumente?ordner=${saved.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  async function remove() {
    try {
      await api(`/folders/${folder!.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['folders'] });
      onClose();
      navigate(folder!.parentId ? `/dokumente?ordner=${folder!.parentId}` : '/dokumente');
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <Sheet title={folder ? `Ordner „${folder.name}“` : parent ? `Neuer Ordner in „${parent.name}“` : 'Neuer Ordner'} open onClose={onClose}>
      <form className="form" noValidate onSubmit={submit}>
        {error && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
        <Field label="Name" name="name" required defaultValue={folder?.name} placeholder="Protokolle" error={error?.fieldError('name')} />
        {groups && groups.length > 0 && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Nur für diese Gruppen <span className="meta">(nichts gewählt = {folder?.parentId || parent ? 'wie der übergeordnete Ordner' : 'alle mit Zugang zu Dokumenten'})</span></legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--s-4)' }}>{groups.map((g) => <label key={g.id} className="check"><input type="checkbox" name="groups" value={g.id} defaultChecked={folder?.groupIds?.includes(g.id)} /> {g.name}</label>)}</div>
          </fieldset>
        )}
        <label className="check"><input type="checkbox" name="share" defaultChecked={folder?.shareWithMembers} /> Im Mitgliederportal für alle Mitglieder zeigen</label>
        <div className="actions-row">
          <button className="btn btn-primary">{folder ? 'Speichern' : 'Ordner anlegen'}</button>
          {folder && <button type="button" className="btn btn-ghost btn-danger" onClick={() => void remove()}>Ordner löschen</button>}
        </div>
      </form>
    </Sheet>
  );
}

export function FileSheet({ id, folders, canWrite, canHold, onClose, onOpen }: { id: string | null; folders: Folder[]; canWrite: boolean; canHold: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: ['file-versions', id], queryFn: () => api<FileDto[]>(`/files/${id}/versions`), enabled: !!id });
  const f = versions.data?.[0];
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const replace = useRef<HTMLInputElement>(null);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['files'] }), qc.invalidateQueries({ queryKey: ['file-versions', id] })]);
  async function patch(body: Record<string, unknown>) {
    setError(undefined);
    try {
      await api(`/files/${id}`, { method: 'PATCH', body });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : 'Das hat nicht geklappt.');
    }
  }
  async function newVersion(file: File) {
    setError(undefined);
    try {
      const v = await uploadFile<FileDto>(`/files/${id}/versions`, file, {});
      await qc.invalidateQueries({ queryKey: ['files'] });
      onOpen(v.id);
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : 'Hochladen fehlgeschlagen.');
    }
  }
  async function remove() {
    try {
      await api(`/files/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['files'] });
      onClose();
    } catch (err) {
      setConfirmDelete(false);
      setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : 'Das hat nicht geklappt.');
    }
  }

  const deletable = f && !f.legalHold && !(f.retainUntil && f.retainUntil > new Date().toISOString().slice(0, 10));
  return (
    <Sheet title={f?.name ?? 'Datei'} open={!!id} onClose={() => { setError(undefined); setConfirmDelete(false); onClose(); }}>
      {!f && <div className="skeleton" style={{ width: '60%' }} />}
      {f && (
        <>
          <div className="actions-row" style={{ marginTop: 0 }}>
            <a className="btn btn-primary" href={`/api/v1/files/${f.id}/content`} download={f.name}>Herunterladen</a>
            {/^(application\/pdf|image\/)/.test(f.mimeType) && <a className="btn" href={`/api/v1/files/${f.id}/content?inline=true`} target="_blank" rel="noreferrer">Ansehen</a>}
            {canWrite && <button className="btn" onClick={() => replace.current?.click()}>Neue Fassung</button>}
            <input ref={replace} type="file" hidden onChange={(e) => { const x = e.target.files?.[0]; if (x) void newVersion(x); e.target.value = ''; }} />
          </div>
          {error && <div className="alert alert-error" role="alert" style={{ marginTop: 'var(--s-3)' }}>{error}</div>}
          <section className="sheet-section">
            <dl className="facts">
              <dt>Name</dt><dd>{canWrite ? <InlineEdit label="Dateiname" value={f.name} onSave={(name) => patch({ name })} /> : f.name}</dd>
              {!f.memberId && (
                <>
                  <dt>Ordner</dt>
                  <dd>
                    {canWrite ? (
                      <select className="select" aria-label="Ordner" value={f.folderId ?? ''} onChange={(e) => void patch({ folderId: e.target.value || null })}>
                        <option value="">Oberste Ebene</option>
                        {folders.map((x) => <option key={x.id} value={x.id}>{pathOf(folders, x)}</option>)}
                      </select>
                    ) : (folders.find((x) => x.id === f.folderId)?.name ?? 'Oberste Ebene')}
                  </dd>
                </>
              )}
              <dt>Aufbewahrung</dt>
              <dd>
                {canWrite ? (
                  <select className="select" aria-label="Aufbewahrung" value={f.retentionClass} onChange={(e) => void patch({ retentionClass: e.target.value })}>
                    {Object.entries(RETENTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                ) : RETENTION_LABEL[f.retentionClass]}
                {f.retainUntil && <div className="meta">Löschen frühestens nach dem {f.retainUntil.split('-').reverse().join('.')}</div>}
              </dd>
              <dt>Löschsperre</dt>
              <dd>{canHold ? <label className="check"><input type="checkbox" checked={f.legalHold} onChange={(e) => void patch({ legalHold: e.target.checked })} /> {f.legalHold ? 'aktiv' : 'keine'}</label> : f.legalHold ? 'aktiv' : 'keine'}</dd>
              <dt>Größe</dt><dd className="num">{bytes(f.sizeBytes)}</dd>
              <dt>Prüfsumme</dt><dd><code className="meta" title="SHA-256">{f.sha256.slice(0, 16)}…</code></dd>
            </dl>
          </section>
          <section className="sheet-section" aria-labelledby="f-versions">
            <h3 id="f-versions">Fassungen</h3>
            <ol className="timeline">
              {versions.data!.map((v) => (
                <li key={v.id} style={{ gridTemplateColumns: 'auto 1fr auto' }}>
                  <span className="meta num">v{v.version}</span>
                  <span>{date(v.createdAt)}{v.uploadedBy && <span className="muted"> · {v.uploadedBy}</span>}<span className="muted"> · {bytes(v.sizeBytes)}</span></span>
                  <a href={`/api/v1/files/${v.id}/content`} download={v.name}>Laden</a>
                </li>
              ))}
            </ol>
          </section>
          {canWrite && (
            <div className="actions-row">
              {confirmDelete ? (
                <><span>Datei mit allen Fassungen löschen?</span><button className="btn btn-danger" onClick={() => void remove()}>Ja, löschen</button><button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Abbrechen</button></>
              ) : (
                <button className="btn btn-ghost btn-danger" disabled={!deletable} title={deletable ? undefined : 'Löschsperre oder Aufbewahrungsfrist'} onClick={() => setConfirmDelete(true)}>Löschen</button>
              )}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

function pathOf(folders: Folder[], f: Folder) {
  const parts = [f.name];
  for (let p = folders.find((x) => x.id === f.parentId), depth = 0; p && depth < 100; p = folders.find((x) => x.id === p!.parentId), depth++) parts.unshift(p.name);
  return parts.join(' / ');
}

