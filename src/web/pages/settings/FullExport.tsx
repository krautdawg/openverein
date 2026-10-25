import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api.ts';
import { isActive, useJobs } from '../../components/JobTray.tsx';
import { bytes } from '../../lib/format.ts';
import { useTitle } from '../../lib/useTitle.ts';

interface Export { id: string; sizeBytes: number; sha256: string; createdAt: string; expiresAt: string }

export function FullExport() {
  useTitle('Gesamtexport');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['full-exports'], queryFn: () => api<Export[]>('/exports/full'), retry: false });
  const [busy, setBusy] = useState(false);
  const jobs = useJobs();
  const running = jobs.data?.find((j) => j.kind === 'full_export' && isActive(j));
  const [error, setError] = useState<string>();

  // The download needs a fresh second factor: a short-lived link is fetched through the API (which asks for the code).
  async function download(id: string) {
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>(`/exports/full/${id}/link`, { method: 'POST' });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    }
  }
  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      await api('/exports/full', { method: 'POST' });
      // The job tray takes over from here and refreshes the list when the export is ready.
      await qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="fx-title">
      <h2 id="fx-title" style={{ marginBottom: 'var(--s-2)' }}>Gesamtexport</h2>
      <p className="muted" style={{ maxWidth: '72ch', marginBottom: 'var(--s-4)' }}>
        Alle Daten Deines Vereins in einer ZIP-Datei: je Tabelle JSON-Lines und CSV, alle gespeicherten Dateien und ein Manifest mit Prüfsummen. Bankverbindungen sind entschlüsselt enthalten, Passwörter und Anmeldegeheimnisse nicht. Der Export bleibt 7 Tage abrufbar; jeder Abruf wird protokolliert. Das Format ist in <code>docs/export-schema.md</code> beschrieben.
      </p>
      {list.error && <div className="alert alert-error" role="alert">{list.error instanceof ApiError ? list.error.problem.title : 'Nicht verfügbar.'}</div>}
      {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-4)' }}>{error}</div>}
      {!list.error && (
        <>
          <div className="actions-row" style={{ marginTop: 0, marginBottom: 'var(--s-4)' }}>
            <button className="btn btn-primary" aria-busy={busy || !!running} disabled={busy || !!running} onClick={() => void run()}>{running ? `Export läuft … ${running.progress} %` : 'Gesamtexport erstellen'}</button>
          </div>
          {running && <p className="muted" style={{ marginBottom: 'var(--s-4)' }}>Der Export läuft im Hintergrund. Du kannst die Seite verlassen; unten rechts siehst Du, wann er fertig ist.</p>}
          <ul className="timeline" aria-label="Exporte">
            {list.data?.length === 0 && <li style={{ gridTemplateColumns: '1fr' }}><span className="muted">Noch kein Export in den letzten 7 Tagen.</span></li>}
            {list.data?.map((x) => (
              <li key={x.id} style={{ gridTemplateColumns: '1fr auto' }}>
                <span>{new Date(x.createdAt).toLocaleString('de-DE')} <span className="meta">· {bytes(x.sizeBytes)} · bis {new Date(x.expiresAt).toLocaleDateString('de-DE')} · SHA-256 {x.sha256.slice(0, 12)}…</span></span>
                <button className="btn btn-ghost" onClick={() => void download(x.id)}>Herunterladen</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
