import { useState, type FormEvent } from 'react';

interface Props {
  label: string;
  value: string;
  onSave: (value: string) => Promise<unknown>;
}

/** Click (or Enter) the value to edit it in place; Enter saves, Escape cancels. No modal. */
export function InlineEdit({ label, value, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div className="inline-edit">
        <button type="button" className="value" onClick={() => { setDraft(value); setError(undefined); setEditing(true); }}>
          {value}
          <span className="sr-only">, {label} bearbeiten</span>
        </button>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (draft === value) return setEditing(false);
    setBusy(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-edit" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
      <input className="input" aria-label={label} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} aria-invalid={error ? true : undefined} />
      <button className="btn btn-primary" aria-busy={busy}>Speichern</button>
      <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Abbrechen</button>
      {error && <span className="error" role="alert">{error}</span>}
    </form>
  );
}
