import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { Field } from '../components/Field.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

interface Poll { id: string; question: string; description: string | null; options: string[]; multiple: boolean; groupId: string | null; closesOn: string; open: boolean; eligible: number; answered: number; counts: number[] }

export function CommunicationNav() {
  return (
    <nav className="subnav" aria-label="Kommunikation">
      <NavLink to="/kommunikation" end>E-Mails</NavLink>
      <NavLink to="/kommunikation/umfragen">Umfragen</NavLink>
    </nav>
  );
}

/** Polls: members answer in the portal; the board sees counts (never who answered what). */
export function Polls({ me }: { me: Me }) {
  useTitle('Umfragen');
  const qc = useQueryClient();
  const polls = useQuery({ queryKey: ['polls'], queryFn: () => api<Poll[]>('/polls'), retry: false });
  const { data: groups } = useGroups();
  const [options, setOptions] = useState(['', '']);
  const [error, setError] = useState<ApiError>();
  const [formKey, setFormKey] = useState(0);
  const canWrite = me.permissions.communication === 'write';

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/polls', { method: 'POST', body: { question: f.get('question'), description: f.get('description') || null, options: options.filter((o) => o.trim()), multiple: f.get('multiple') === 'on', groupId: f.get('groupId') || null, closesOn: f.get('closesOn') } });
      await qc.invalidateQueries({ queryKey: ['polls'] });
      setOptions(['', '']);
      setFormKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <div className="page">
      <PageHead title="Kommunikation" intro="Umfragen unter den Mitgliedern: geantwortet wird im Mitgliederportal, eine Antwort je Mitgliedschaft. Ergebnisse sehen Mitglieder erst nach dem Ende." />
      <CommunicationNav />
      {polls.error && <div className="alert alert-error" role="alert">{polls.error instanceof ApiError ? polls.error.problem.title : 'Nicht verfügbar.'}</div>}
      {canWrite && (
        <form key={formKey} className="form" style={{ maxWidth: 640, marginBottom: 'var(--s-7)' }} noValidate onSubmit={(e) => void create(e)} aria-label="Neue Umfrage">
          {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? [error.problem.title, error.problem.detail].filter(Boolean).join(' ')}</div>}
          <Field label="Frage" name="question" placeholder="z. B. Sommerfest am Samstag oder Sonntag?" error={error?.fieldError('question')} />
          <fieldset className="agenda-edit">
            <legend>Antworten</legend>
            <ol>{options.map((o, i) => <li key={i}><input className="input" aria-label={`Antwort ${i + 1}`} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} /></li>)}</ol>
            <button type="button" className="btn btn-ghost" onClick={() => setOptions([...options, ''])}>Antwort hinzufügen</button>
          </fieldset>
          <label className="check"><input type="checkbox" name="multiple" /> Mehrere Antworten erlaubt</label>
          <div className="form-row">
            <Field label="Läuft bis" name="closesOn" type="date" error={error?.fieldError('closesOn')} />
            <div className="field"><label htmlFor="poll-group">Wer antwortet</label><select id="poll-group" name="groupId" className="select"><option value="">Alle aktuellen Mitglieder</option>{groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
          </div>
          <div className="actions-row"><button className="btn btn-primary">Umfrage starten</button></div>
        </form>
      )}
      <ul className="poll-list" aria-label="Umfragen">
        {polls.data?.length === 0 && <li className="muted">Noch keine Umfrage.</li>}
        {polls.data?.map((p) => (
          <li key={p.id}>
            <div className="poll-head">
              <strong>{p.question}</strong>
              <span className="meta">{p.open ? `läuft bis ${formatDate(p.closesOn)}` : `beendet am ${formatDate(p.closesOn)}`} · {p.answered} von {p.eligible} haben geantwortet</span>
            </div>
            <PollBars options={p.options} counts={p.counts} answered={p.answered} />
            {canWrite && p.open && <button className="btn btn-ghost" onClick={() => void api(`/polls/${p.id}/close`, { method: 'POST' }).then(() => qc.invalidateQueries({ queryKey: ['polls'] }))}>Jetzt beenden</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Results as court lines: one hairline per answer, filled by its share. */
export function PollBars({ options, counts, answered }: { options: string[]; counts: number[]; answered: number }) {
  return (
    <ul className="poll-bars">
      {options.map((o, i) => {
        const share = answered ? Math.round((counts[i]! / answered) * 100) : 0;
        return (
          <li key={i}>
            <span>{o}</span>
            <span className="num meta">{counts[i]} · {share} %</span>
            <span className="budget-line" aria-hidden style={{ width: '100%' }}><span style={{ width: `${share}%` }} /></span>
          </li>
        );
      })}
    </ul>
  );
}
