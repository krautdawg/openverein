import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import type { Task } from '../../shared/tasks.ts';
import { Field } from '../components/Field.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

type Filter = 'open' | 'mine' | 'done';

export function Tasks({ me }: { me: Me }) {
  useTitle('Aufgaben');
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');
  const tasks = useQuery({ queryKey: ['tasks', filter], queryFn: () => api<Task[]>(`/tasks?filter=${filter}`) });
  const people = useQuery({ queryKey: ['task-assignees'], queryFn: () => api<{ id: string; name: string }[]>('/tasks/assignees') });
  const [error, setError] = useState<ApiError>();
  const [formKey, setFormKey] = useState(0);
  const reload = () => qc.invalidateQueries({ queryKey: ['tasks'] });

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/tasks', { method: 'POST', body: { title: f.get('title'), dueOn: f.get('dueOn') || null, assigneeUserId: f.get('assignee') || null, note: f.get('note') || null } });
      setFormKey((k) => k + 1);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <div className="page">
      <PageHead title="Aufgaben" intro="Was zu tun ist, wer es macht und bis wann." />
      {/* Remounts once the people are loaded, so "me" is preselected as the default assignee. */}
      <form key={`${formKey}-${people.data?.length ?? 0}`} className="inline-form" noValidate onSubmit={add} aria-label="Neue Aufgabe" style={{ marginTop: 0, marginBottom: 'var(--s-5)' }}>
        <div className="form-row">
          <Field label="Aufgabe" name="title" error={error?.fieldError('title')} />
          <div className="field">
            <label htmlFor="t-assignee">Zuständig</label>
            <select id="t-assignee" name="assignee" className="select" defaultValue={me.id}>
              <option value="">niemand</option>
              {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <p className="hint">Bekommt eine E-Mail, wenn es nicht Du bist.</p>
          </div>
        </div>
        <div className="form-row">
          <Field label="Bis (optional)" name="dueOn" type="date" error={error?.fieldError('dueOn')} />
          <Field label="Notiz (optional)" name="note" />
        </div>
        <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Aufgabe anlegen</button></div>
      </form>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Ansicht">
          {(['open', 'mine', 'done'] as const).map((f) => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ open: 'Offen', mine: 'Meine', done: 'Erledigt' }[f]}</button>)}
        </div>
      </div>
      {tasks.data?.length === 0 ? (
        <div className="empty-state"><h3>{filter === 'done' ? 'Noch nichts erledigt.' : 'Nichts offen.'}</h3><p>{filter === 'done' ? 'Erledigte Aufgaben erscheinen hier.' : 'Neue Aufgaben legst Du oben an.'}</p></div>
      ) : (
        <ul className="task-list" aria-label="Aufgaben">
          {tasks.data?.map((t) => <TaskRow key={t.id} t={t} meId={me.id} onChange={reload} />)}
        </ul>
      )}
    </div>
  );
}

export function TaskRow({ t, meId, onChange }: { t: Task; meId: string; onChange: () => unknown }) {
  async function patch(body: Record<string, unknown>) {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body });
    await onChange();
  }
  return (
    <li data-done={t.done}>
      <input type="checkbox" aria-label={`${t.title} erledigt`} checked={t.done} disabled={!t.canEdit} onChange={(e) => void patch({ done: e.target.checked })} />
      <div>
        <span className="name">{t.title}</span>
        {t.note && <p className="meta" style={{ margin: 0 }}>{t.note}</p>}
        <p className="meta" style={{ margin: 0 }}>
          {[t.assignee ? (t.assignee.id === meId ? 'Du' : t.assignee.name) : 'niemand zuständig', t.dueOn && (t.overdue ? null : `bis ${formatDate(t.dueOn)}`)].filter(Boolean).join(' · ')}
          {t.overdue && t.dueOn && <span className="overdue"> · seit {formatDate(t.dueOn)} fällig</span>}
          {t.member && <> · <Link to={`/mitglieder/${t.member.id}`}>{t.member.name}</Link></>}
        </p>
      </div>
      {t.canDelete && <button className="linklike" onClick={async () => { await api(`/tasks/${t.id}`, { method: 'DELETE' }); await onChange(); }}>löschen</button>}
    </li>
  );
}
