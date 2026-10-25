import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../../shared/auth.ts';
import { TARGETS, type Target } from '../../../shared/import.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

interface Preview {
  headers: string[];
  mapping: Record<string, Target | null>;
  unmapped: string[];
  rows: { line: number; action: 'create' | 'update' | 'skip' | 'error'; name: string; messages: string[] }[];
  counts: { create: number; update: number; skip: number; error: number };
  newGroups: string[];
}
interface Run { id: string; fileName: string | null; preset: string | null; counts: Record<string, number>; createdAt: string; rolledBackAt: string | null }

/** Exports from easyVerein and Excel are often Windows-1252; UTF-8 is tried first and must decode cleanly. */
async function readText(file: File) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

const MATCH = { number: 'Mitgliedsnummer', email: 'E-Mail-Adresse', name_birth: 'Nachname und Geburtsdatum' } as const;

export function ImportSettings({ me }: { me: Me }) {
  useTitle('Import');
  const qc = useQueryClient();
  const canWrite = me.permissions.imports === 'write' && me.permissions.members === 'write';
  const runs = useQuery({ queryKey: ['imports'], queryFn: () => api<Run[]>('/imports') });
  const [file, setFile] = useState<{ name: string; content: string }>();
  const [preset, setPreset] = useState<'easyverein' | 'generic'>('easyverein');
  const [matchKey, setMatchKey] = useState<keyof typeof MATCH>('number');
  const [mapping, setMapping] = useState<Record<string, Target | null>>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [confirmRollback, setConfirmRollback] = useState<string | null>(null);

  const body = () => ({ fileName: file!.name, content: file!.content, preset, matchKey, mapping });
  const fail = (err: unknown) => setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');

  async function run(dry: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      if (dry) {
        const p = await api<Preview>('/imports/members/preview', { method: 'POST', body: body() });
        setPreview(p);
        setMapping(p.mapping);
      } else {
        const r = await api<Run>('/imports/members', { method: 'POST', body: body() });
        setDone(`Importiert: ${r.counts.create ?? 0} neu, ${r.counts.update ?? 0} aktualisiert, ${r.counts.error ?? 0} Zeilen mit Fehlern übersprungen.`);
        setPreview(undefined);
        setFile(undefined);
        setMapping(undefined);
        await Promise.all([qc.invalidateQueries({ queryKey: ['imports'] }), qc.invalidateQueries({ queryKey: ['members'] }), qc.invalidateQueries({ queryKey: ['groups'] })]);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }
  async function rollback(id: string) {
    setError(undefined);
    try {
      await api(`/imports/${id}/rollback`, { method: 'POST' });
      await Promise.all([qc.invalidateQueries({ queryKey: ['imports'] }), qc.invalidateQueries({ queryKey: ['members'] })]);
    } catch (err) {
      fail(err);
    }
  }

  const problems = preview?.rows.filter((r) => r.action !== 'create' && r.action !== 'update' || r.messages.length) ?? [];
  return (
    <>
      <section aria-labelledby="imp">
        <h2 id="imp" style={{ marginBottom: 'var(--s-2)' }}>Mitglieder importieren</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>
          Aus easyVerein: Mitglieder → Import/Export → „Mitgliederdaten aller Tabelleneinträge exportieren“ als CSV. Andere Programme gehen auch, solange es eine CSV-Datei mit Kopfzeile ist. Erst kommt ein Probelauf; geschrieben wird nur, was Du dann bestätigst.
        </p>
        {done && <div className="alert alert-ok" role="status">{done}</div>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {canWrite && (
          <div className="inline-form" style={{ maxWidth: 720 }}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="imp-file">CSV-Datei</label>
                <input id="imp-file" type="file" accept=".csv,text/csv" className="input" onChange={async (e) => { const f = e.target.files?.[0]; setPreview(undefined); setMapping(undefined); setDone(undefined); setFile(f ? { name: f.name, content: await readText(f) } : undefined); }} />
              </div>
              <div className="field">
                <label htmlFor="imp-preset">Herkunft</label>
                <select id="imp-preset" className="select" value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
                  <option value="easyverein">easyVerein</option>
                  <option value="generic">Andere Tabelle</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="imp-match">Vorhandene Mitglieder erkennen an</label>
              <select id="imp-match" className="select" value={matchKey} onChange={(e) => setMatchKey(e.target.value as keyof typeof MATCH)}>
                {Object.entries(MATCH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="actions-row" style={{ marginTop: 0 }}>
              <button className="btn btn-primary" disabled={!file || busy} aria-busy={busy} onClick={() => void run(true)}>{preview ? 'Probelauf wiederholen' : 'Probelauf'}</button>
            </div>
          </div>
        )}
      </section>

      {preview && mapping && (
        <section className="section" aria-labelledby="map">
          <h2 id="map">Spalten</h2>
          <p className="muted" style={{ marginBottom: 'var(--s-3)' }}>Erkannte Spalten sind zugeordnet. Prüf sie und wiederhole den Probelauf, wenn Du etwas änderst.</p>
          <div className="table-wrap" style={{ maxWidth: 720 }}>
            <table className="table" aria-label="Spaltenzuordnung">
              <thead><tr><th scope="col">Spalte in der Datei</th><th scope="col">wird zu</th></tr></thead>
              <tbody>
                {preview.headers.map((h) => (
                  <tr key={h}>
                    <td>{h}</td>
                    <td>
                      <select className="select" aria-label={`Ziel für ${h}`} value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: (e.target.value || null) as Target | null })}>
                        <option value="">nicht übernehmen</option>
                        {(Object.keys(TARGETS) as Target[]).map((t) => <option key={t} value={t}>{TARGETS[t].label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 style={{ marginTop: 'var(--s-6)' }}>Probelauf</h2>
          <dl className="figures" style={{ marginTop: 'var(--s-3)' }}>
            <div><dt>neu</dt><dd>{preview.counts.create}</dd></div>
            <div><dt>aktualisiert</dt><dd>{preview.counts.update}</dd></div>
            <div><dt>übersprungen</dt><dd>{preview.counts.skip}</dd></div>
            <div><dt>mit Fehlern</dt><dd>{preview.counts.error}</dd></div>
          </dl>
          {preview.newGroups.length > 0 && <p style={{ marginTop: "var(--s-4)" }}>Neue Gruppen: {preview.newGroups.join(', ')}</p>}
          {problems.length > 0 && (
            <ul className="timeline" aria-label="Hinweise je Zeile" style={{ maxWidth: 720 }}>
              {problems.map((r) => (
                <li key={r.line} style={{ gridTemplateColumns: 'auto 1fr' }}>
                  <span className="meta num">Zeile {r.line}</span>
                  <span><span className="name">{r.name}</span> <span className="status" data-s={r.action === 'error' ? 'rejected' : 'future'}>{r.action === 'error' ? 'Fehler' : r.action === 'skip' ? 'übersprungen' : 'Hinweis'}</span><div className="meta">{r.messages.join(' ')}</div></span>
                </li>
              ))}
            </ul>
          )}
          <div className="actions-row">
            <button className="btn btn-primary" disabled={busy || preview.counts.create + preview.counts.update === 0} aria-busy={busy} onClick={() => void run(false)}>{preview.counts.create + preview.counts.update} Mitglieder importieren</button>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="runs">
        <h2 id="runs">Bisherige Importe</h2>
        {runs.data?.length === 0 && <p className="muted">Noch keine.</p>}
        <ul className="timeline" style={{ maxWidth: 720 }}>
          {runs.data?.map((r) => (
            <li key={r.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <span>{r.fileName ?? 'Import'} <span className="meta">· {new Date(r.createdAt).toLocaleString('de-DE')} · {r.counts.create ?? 0} neu, {r.counts.update ?? 0} aktualisiert</span>{r.rolledBackAt && <span className="pill" style={{ marginLeft: 8 }}>zurückgenommen</span>}</span>
              {canWrite && !r.rolledBackAt && (confirmRollback === r.id
                ? <span className="actions-inline"><span className="meta">Neu angelegte Mitglieder löschen?</span><button className="btn btn-danger" onClick={() => { setConfirmRollback(null); void rollback(r.id); }}>Ja</button><button className="btn btn-ghost" onClick={() => setConfirmRollback(null)}>Nein</button></span>
                : <button className="btn btn-ghost" onClick={() => setConfirmRollback(r.id)}>Zurücknehmen</button>)}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
