import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { formatDate } from '../../shared/dates.ts';
import { api, ApiError } from '../lib/api.ts';

interface ChangeRequest { id: string; memberId: string; memberName: string; field: string; oldValue: string | null; newValue: string; requestedAt: string }
const LABEL: Record<string, string> = { first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail-Adresse', phone: 'Telefon', street: 'Straße', postal_code: 'Postleitzahl', city: 'Ort', iban: 'IBAN', resignation: 'Kündigung zum' };

/** Wishes from the member portal: one line per change, old → new, decided in place. */
export function ChangeInbox({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['change-requests'], queryFn: () => api<ChangeRequest[]>('/change-requests') });
  const [denying, setDenying] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  if (!data?.length) return null;

  async function decide(c: ChangeRequest, action: 'accept' | 'deny') {
    setError(undefined);
    try {
      await api(`/change-requests/${c.id}/${action}`, { method: 'POST', body: action === 'deny' ? { reason } : {} });
      setDenying(null);
      setReason('');
      if (action === 'accept' && c.field === 'iban') setNote(`Neue IBAN für ${c.memberName} übernommen; die nächste Lastschrift meldet die Kontoänderung der Bank. Wechselt die Kontoinhaberin oder der Kontoinhaber, brauchst Du ein neues Mandat.`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['change-requests'] }), qc.invalidateQueries({ queryKey: ['members'] })]);
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    }
  }

  return (
    <section className="section" aria-labelledby="changes">
      <h2 id="changes">Aus dem Mitgliederportal <span className="meta">({data.length})</span></h2>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {note && <div className="alert alert-ok" role="status">{note}</div>}
      <ul className="timeline change-inbox">
        {data.map((c) => (
          <li key={c.id}>
            <span>
              <Link to={`/mitglieder/${c.memberId}`} className="name">{c.memberName}</Link>
              <div>
                <span className="meta">{LABEL[c.field]}: </span>
                {c.field === 'resignation' ? <strong>{formatDate(c.newValue)}</strong> : <>{c.oldValue && <del className="muted">{c.oldValue}</del>} <ins>{c.newValue}</ins></>}
              </div>
              <div className="meta">{new Date(c.requestedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div>
              {denying === c.id && (
                <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void decide(c, 'deny'); }}>
                  <label htmlFor={`r-${c.id}`}>Begründung für das Mitglied</label>
                  <input id={`r-${c.id}`} className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z. B. Bitte mit Hausnummer" />
                  <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary" disabled={reason.trim().length < 3}>Ablehnen und mitteilen</button><button type="button" className="btn btn-ghost" onClick={() => setDenying(null)}>Abbrechen</button></div>
                </form>
              )}
            </span>
            {canWrite && denying !== c.id && (
              <span className="actions-inline">
                <button className="btn btn-primary" onClick={() => void decide(c, 'accept')}>{c.field === 'resignation' ? 'Bestätigen' : 'Übernehmen'}</button>
                <button className="btn btn-ghost" onClick={() => { setDenying(c.id); setReason(''); }}>Ablehnen</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
