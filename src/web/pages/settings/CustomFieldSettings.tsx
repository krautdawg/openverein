import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../../shared/auth.ts';
import { CUSTOM_FIELD_TYPE_LABEL, CUSTOM_FIELD_TYPES, type CustomField, type CustomFieldType } from '../../../shared/customFields.ts';
import { useCustomFields } from '../../components/CustomFields.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

// "Trikotgröße" → "trikotgroesse": a stable key for placeholders and the API.
const slug = (label: string) => label.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);

export function CustomFieldSettings({ me }: { me: Me }) {
  useTitle('Eigene Felder');
  const qc = useQueryClient();
  const { data: fields } = useCustomFields();
  const canWrite = me.permissions.settings === 'write';
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<CustomField | null>(null);
  const [confirm, setConfirm] = useState('');

  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['custom-fields'] });
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.map((x) => x.message).join(' ') ?? [err.problem.title, err.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');
      return false;
    }
  }
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const options = String(f.get('options') ?? '').split('\n').map((o) => o.trim()).filter(Boolean);
    if (await run(() => api('/custom-fields', { method: 'POST', body: { label, key: slug(label), type, options, required: f.get('required') === 'on', sensitive: f.get('sensitive') === 'on', position: (fields?.length ?? 0) * 10 } }))) {
      setAdding(false);
      setLabel('');
      setType('text');
    }
  }

  return (
    <section aria-labelledby="cf-title">
      <h2 id="cf-title" style={{ marginBottom: 'var(--s-2)' }}>Eigene Felder</h2>
      <p className="muted" style={{ maxWidth: '72ch', marginBottom: 'var(--s-4)' }}>Angaben, die Dein Verein zusätzlich braucht, etwa Trikotgröße oder Lizenznummer. Sie erscheinen im Mitgliedsprofil, im CSV-Export, als Filter in der API und in E-Mails als <code>{'{{custom.schluessel}}'}</code>. Sensible Felder sehen nur Zugänge für den ganzen Verein; sie stehen nicht in E-Mails.</p>
      {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-4)' }}>{error}</div>}
      <div className="table-wrap">
        {fields?.length === 0 ? (
          <p className="empty">Noch keine eigenen Felder.</p>
        ) : (
          <table className="table" aria-label="Eigene Felder">
            <thead><tr><th scope="col">Feld</th><th scope="col">Typ</th><th scope="col" className="hide-sm">Platzhalter</th><th scope="col" className="num">Werte</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
            <tbody>
              {fields?.map((f) => (
                <tr key={f.id}>
                  <td><span className="name">{f.label}</span>{f.required && <span className="meta"> · Pflicht</span>}{f.sensitive && <span className="meta"> · sensibel</span>}{f.archived && <span className="pill" style={{ marginLeft: 8 }}>archiviert</span>}</td>
                  <td>{CUSTOM_FIELD_TYPE_LABEL[f.type]}{f.options.length > 0 && <div className="meta">{f.options.join(', ')}</div>}</td>
                  <td className="hide-sm">{f.sensitive ? <span className="muted">nicht in E-Mails</span> : <code>{`{{custom.${f.key}}}`}</code>}</td>
                  <td className="num">{f.valueCount}</td>
                  <td>
                    {canWrite && (
                      <span style={{ display: 'inline-flex', gap: 'var(--s-1)' }}>
                        <button className="btn btn-ghost" aria-label={`${f.label} ${f.archived ? 'wieder zeigen' : 'archivieren'}`} onClick={() => void run(() => api(`/custom-fields/${f.id}`, { method: 'PATCH', body: { archived: !f.archived } }))}>{f.archived ? 'Zeigen' : 'Archivieren'}</button>
                        <button className="btn btn-ghost" aria-label={`${f.label} löschen`} onClick={() => { setDeleting(f); setConfirm(''); }}>Löschen …</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {deleting && (
        <form className="inline-form" style={{ maxWidth: 560, marginTop: 'var(--s-4)' }} noValidate onSubmit={(e) => { e.preventDefault(); void run(() => api(`/custom-fields/${deleting.id}`, { method: 'DELETE', body: { confirm } })).then((ok) => ok && setDeleting(null)); }}>
          <p>{deleting.valueCount ? `${deleting.valueCount} Personen haben einen Wert in „${deleting.label}“. Die Werte werden endgültig gelöscht. Gib zur Bestätigung den Namen des Feldes ein.` : `„${deleting.label}“ hat keine Werte und wird gelöscht.`}</p>
          {deleting.valueCount > 0 && <div className="field"><label htmlFor="cf-confirm">Name des Feldes</label><input id="cf-confirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>}
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-danger" disabled={deleting.valueCount > 0 && confirm !== deleting.label}>Löschen</button><button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>Abbrechen</button></div>
        </form>
      )}
      {canWrite && (adding ? (
        <form className="inline-form" style={{ maxWidth: 560, marginTop: 'var(--s-4)' }} noValidate onSubmit={(e) => void add(e)}>
          <div className="form-row">
            <div className="field"><label htmlFor="cf-label">Bezeichnung</label><input id="cf-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus /><span className="hint">Platzhalter: <code>{`{{custom.${slug(label) || '…'}}}`}</code></span></div>
            <div className="field"><label htmlFor="cf-type">Typ</label><select id="cf-type" className="select" style={{ width: '100%' }} value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>{CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABEL[t]}</option>)}</select></div>
          </div>
          {(type === 'select' || type === 'multiselect') && <div className="field"><label htmlFor="cf-options">Auswahlmöglichkeiten (eine pro Zeile)</label><textarea id="cf-options" name="options" className="textarea" /></div>}
          <label className="check"><input type="checkbox" name="required" /> Pflichtfeld bei neuen Mitgliedern</label>
          <label className="check"><input type="checkbox" name="sensitive" /> Sensibel (z. B. Gesundheit): nur für Zugänge für den ganzen Verein</label>
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Feld anlegen</button><button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Abbrechen</button></div>
        </form>
      ) : (
        <div className="actions-row"><button className="btn" onClick={() => setAdding(true)}>Feld hinzufügen</button></div>
      ))}
    </section>
  );
}
