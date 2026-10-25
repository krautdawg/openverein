import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { formatDate } from '../../shared/dates.ts';
import type { FileDto } from '../../shared/documents.ts';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';

interface Entry { id: string; kind: Kind; occurredOn: string; text: string; fileId: string | null; fileName: string | null; private: boolean; author: string; mine: boolean }
type Kind = 'call' | 'meeting' | 'letter' | 'email' | 'other';
const KIND_LABEL: Record<Kind, string> = { call: 'Anruf', meeting: 'Treffen', letter: 'Brief', email: 'E-Mail', other: 'Sonstiges' };

/** Contact log: calls, meetings and letters with the person, newest first; private entries only for their author. */
export function MemberContacts({ memberId, canWrite }: { memberId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['member-contacts', memberId], queryFn: () => api<Entry[]>(`/members/${memberId}/contacts`) });
  const files = useQuery({ queryKey: ['files', 'member', memberId], queryFn: () => api<FileDto[]>(`/files?memberId=${memberId}`), enabled: canWrite });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ApiError>();
  const reload = () => qc.invalidateQueries({ queryKey: ['member-contacts', memberId] });

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api(`/members/${memberId}/contacts`, { method: 'POST', body: { kind: f.get('kind'), occurredOn: f.get('occurredOn'), text: f.get('text'), fileId: f.get('fileId') || null, private: f.get('private') === 'on' } });
      setAdding(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  if (!data || (!data.length && !canWrite)) return null;
  return (
    <section className="sheet-section" aria-labelledby="m-contacts">
      <h3 id="m-contacts">Kontaktverlauf</h3>
      {data.length === 0 && !adding && <p className="muted">Anrufe, Treffen und Briefe, damit der Vorstand weiß, was besprochen wurde.</p>}
      <ul className="timeline" aria-label="Kontakte">
        {data.map((c) => (
          <li key={c.id} style={{ gridTemplateColumns: '5.5rem 1fr auto' }}>
            <span className="meta num">{formatDate(c.occurredOn)}</span>
            <span>
              <strong>{KIND_LABEL[c.kind]}</strong>{c.private && <span className="meta"> <Lock size={12} aria-label="privat" /> nur für Dich</span>}
              <span style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{c.text}</span>
              {c.fileId && <a className="meta" href={`/api/v1/files/${c.fileId}/content`} download={c.fileName ?? undefined}>{c.fileName}</a>}
              <span className="meta" style={{ display: 'block' }}>{c.author}</span>
            </span>
            {c.mine && canWrite ? <button className="linklike" onClick={async () => { await api(`/members/${memberId}/contacts/${c.id}`, { method: 'DELETE' }); await reload(); }}>löschen</button> : <span />}
          </li>
        ))}
      </ul>
      {canWrite && (adding ? (
        <form className="inline-form" noValidate onSubmit={add} aria-label="Neuer Kontakt">
          {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.title}</div>}
          <div className="form-row">
            <div className="field"><label htmlFor="c-kind">Art</label><select id="c-kind" name="kind" className="select">{(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></div>
            <div className="field"><label htmlFor="c-date">Datum</label><input id="c-date" name="occurredOn" type="date" className="input" defaultValue={todayLocal()} max={todayLocal()} /></div>
          </div>
          <div className="field"><label htmlFor="c-text">Notiz</label><textarea id="c-text" name="text" className="textarea" rows={3} autoFocus />{error?.fieldError('text') && <p className="error">{error.fieldError('text')}</p>}</div>
          {!!files.data?.length && (
            <div className="field"><label htmlFor="c-file">Datei (optional)</label><select id="c-file" name="fileId" className="select"><option value="">keine</option>{files.data.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
          )}
          <label className="check"><input type="checkbox" name="private" /> Nur für mich sichtbar</label>
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Speichern</button><button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Abbrechen</button></div>
        </form>
      ) : <div className="actions-row"><button className="btn" onClick={() => setAdding(true)}>Kontakt eintragen</button></div>)}
    </section>
  );
}
