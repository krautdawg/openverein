import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import type { Me } from '../../../shared/auth.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

type Type = { key: string; label: string; fresh?: boolean; rowId?: string };
let nextRow = 0;
/** A stable id per row for React (the key changes while a new label is typed). */
const rowIdOf = (t: Type) => t.rowId ?? `saved-${t.key}`;

/** A key from a label: lower case, umlauts spelled out, the rest a dash (fixed once saved). */
const keyOf = (label: string) => label.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'art';

/** The kinds of public profiles the club shows (e.g. trainers, board, experts). Members pick one in the portal. */
export function ProfileTypes({ me }: { me: Me }) {
  useTitle('Profile');
  const qc = useQueryClient();
  const canWrite = me.permissions.settings === 'write';
  const saved = useQuery({ queryKey: ['profile-types'], queryFn: () => api<Type[]>('/profile-types') });
  const [draft, setDraft] = useState<Type[] | null>(null);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const rows = draft ?? saved.data ?? [];

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setDone(false);
    try {
      const types = rows.filter((t) => t.label.trim()).map((t) => ({ key: t.key, label: t.label.trim() }));
      qc.setQueryData(['profile-types'], await api<Type[]>('/profile-types', { method: 'PUT', body: { types } }));
      setDraft(null);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.map((x) => x.message).join(' ') ?? err.problem.title) : 'Das hat nicht geklappt.');
    }
  }

  const removed = (saved.data ?? []).filter((t) => !rows.some((r) => r.key === t.key));
  return (
    <>
      <div className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h2>Profile</h2>
          <p>Mitglieder können im Portal ein Profil für die Website des Vereins schreiben und wählen dafür eine dieser Arten. Ohne Art ist ein Profil nicht öffentlich. Freigegeben wird unter Mitglieder → Profile.</p>
        </div>
      </div>
      <form className="inline-form profile-types" onSubmit={(e) => void save(e)} noValidate aria-label="Profilarten">
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {rows.length === 0 && <p className="muted">Noch keine Profilarten: Profile bleiben dann alle nicht öffentlich.</p>}
        <ul className="profile-types-list">
          {rows.map((t, i) => (
            <li key={rowIdOf(t)}>
              <label className="sr-only" htmlFor={`type-${i}`}>Bezeichnung</label>
              <input id={`type-${i}`} className="input" value={t.label} disabled={!canWrite} maxLength={60} onChange={(e) => setDraft(rows.map((x, j) => (j === i ? { ...x, label: e.target.value, key: x.fresh ? keyOf(e.target.value) : x.key } : x)))} />
              <span className="meta">{t.key}</span>
              {canWrite && <button type="button" className="icon-btn" aria-label={`${t.label || 'Art'} entfernen`} onClick={() => setDraft(rows.filter((_, j) => j !== i))}><Trash2 size={16} aria-hidden /></button>}
            </li>
          ))}
        </ul>
        {canWrite && rows.length < 20 && <button type="button" className="btn btn-ghost" onClick={() => setDraft([...rows, { key: `art-${rows.length + 1}`, label: '', fresh: true, rowId: `new-${nextRow++}` }])}><Plus size={16} aria-hidden /> Art hinzufügen</button>}
        {removed.length > 0 && <p className="alert alert-warn">Profile der Art {removed.map((t) => `„${t.label}“`).join(', ')} sind nach dem Speichern nicht mehr öffentlich.</p>}
        {done && <p className="profile-saved" role="status">Gespeichert.</p>}
        {canWrite && <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Speichern</button></div>}
      </form>
    </>
  );
}
