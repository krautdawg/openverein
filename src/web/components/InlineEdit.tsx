import { useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.ts';

interface Props {
  label: string;
  value: string | null | undefined;
  onSave: (value: string) => Promise<unknown>;
  type?: 'text' | 'email' | 'date' | 'tel' | 'textarea';
  /** Formats the stored value for display (e.g. dates). */
  display?: (value: string) => string;
  /** Field name in API validation errors, to show the server's message inline. */
  field?: string;
}

/** Click (or Enter) the value to edit it in place; Enter saves, Escape cancels. No modal. */
export function InlineEdit({ label, value, onSave, type = 'text', display, field }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div className="inline-edit">
        <button type="button" className="value" onClick={() => { setDraft(value ?? ''); setError(undefined); setEditing(true); }}>
          {value ? (display ? display(value) : value) : <span className="placeholder">hinzufügen</span>}
          <span className="sr-only">, {label} bearbeiten</span>
        </button>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (draft === (value ?? '')) return setEditing(false);
    setBusy(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? (field && err.fieldError(field)) || err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const common = {
    'aria-label': label,
    value: draft,
    autoFocus: true,
    'aria-invalid': error ? true : undefined,
  } as const;

  return (
    <form className="inline-edit" style={{ flexWrap: 'wrap' }} onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(false))}>
      {type === 'textarea' ? (
        <textarea className="textarea" {...common} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(e)} />
      ) : (
        <input className="input" type={type} {...common} onChange={(e) => setDraft(e.target.value)} style={{ flex: '1 1 160px' }} />
      )}
      <button className="btn btn-primary" aria-busy={busy}>Speichern</button>
      <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Abbrechen</button>
      {error && <span className="error" role="alert" style={{ flexBasis: '100%' }}>{error}</span>}
    </form>
  );
}
