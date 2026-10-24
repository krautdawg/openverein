import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

export interface Application {
  id: string;
  formTitle: string;
  status: 'new' | 'accepted' | 'rejected' | 'spam';
  data: { firstName: string; lastName: string; birthDate: string; email: string; phone?: string; street: string; postalCode: string; city: string; guardian?: { name: string; email: string; phone?: string } | null; mandate?: { accountHolder: string; iban: string } | null; note?: string };
  consent: { text: string; version: number; acceptedAt: string };
  groups: { id: string; name: string }[];
  feePlan: { id: string; name: string } | null;
  minor: boolean;
  duplicates: { memberId: string; name: string; number: string; reason: string }[];
  memberId: string | null;
  reason: string | null;
  createdAt: string;
}

const TABS = [['new', 'Neu'], ['accepted', 'Angenommen'], ['rejected', 'Abgelehnt'], ['spam', 'Spam']] as const;

export function Applications({ me }: { me: Me }) {
  useTitle('Aufnahmeanträge');
  const navigate = useNavigate();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'new') as Application['status'];
  const { data } = useQuery({ queryKey: ['applications', status], queryFn: () => api<Application[]>(`/applications?status=${status}`) });
  const [selected, setSelected] = useState<string[]>([]);
  const qc = useQueryClient();
  const canWrite = me.permissions.members === 'write';

  async function markSpam() {
    await api('/applications/decide', { method: 'POST', body: { ids: selected, action: 'spam' } });
    setSelected([]);
    await qc.invalidateQueries({ queryKey: ['applications'] });
  }

  return (
    <div className="page">
      <PageHead title="Aufnahmeanträge" intro={<>Anträge aus dem Online-Formular. Die Formulare richtest Du unter <Link to="/einstellungen/aufnahme">Einstellungen → Aufnahme</Link> ein.</>} />
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Status">
          {TABS.map(([k, label]) => <button key={k} aria-pressed={status === k} onClick={() => { setSelected([]); setParams(k === 'new' ? {} : { status: k }); }}>{label}</button>)}
        </div>
        {canWrite && status === 'new' && selected.length > 0 && <button className="btn" onClick={() => void markSpam()}>{selected.length} als Spam markieren</button>}
      </div>
      <div className="table-wrap">
        {data?.length === 0 ? (
          <div className="empty-state"><h3>{status === 'new' ? 'Keine neuen Anträge.' : 'Hier ist nichts.'}</h3><p>{status === 'new' ? 'Neue Anträge aus dem Formular erscheinen hier.' : ''}</p></div>
        ) : (
          <table className="table" aria-label="Anträge">
            <thead><tr>{canWrite && status === 'new' && <th scope="col" style={{ width: 40 }}><span className="sr-only">Auswahl</span></th>}<th scope="col">Name</th><th scope="col" className="hide-sm">Gruppen</th><th scope="col" className="hide-sm">Hinweise</th><th scope="col" className="num">Eingang</th></tr></thead>
            <tbody>
              {data?.map((a) => (
                <tr key={a.id} data-href tabIndex={0} aria-selected={a.id === id} onClick={() => navigate(`/antraege/${a.id}${status === 'new' ? '' : `?status=${status}`}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/antraege/${a.id}`)}>
                  {canWrite && status === 'new' && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`${a.data.firstName} ${a.data.lastName} auswählen`} checked={selected.includes(a.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
                    </td>
                  )}
                  <td><span className="name">{a.data.lastName}, {a.data.firstName}</span>{a.minor && <span className="pill" style={{ marginLeft: 8 }}>minderjährig</span>}</td>
                  <td className="hide-sm">{a.groups.map((g) => g.name).join(', ')}</td>
                  <td className="hide-sm">{a.duplicates.length > 0 && <span style={{ color: 'var(--warn)' }}>vielleicht schon Mitglied</span>}{a.data.mandate && <span className="muted">{a.duplicates.length ? ' · ' : ''}Lastschrift</span>}</td>
                  <td className="num">{new Date(a.createdAt).toLocaleDateString('de-DE')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ApplicationSheet application={data?.find((a) => a.id === id) ?? null} canWrite={canWrite} onClose={() => navigate(status === 'new' ? '/antraege' : `/antraege?status=${status}`)} />
    </div>
  );
}

function ApplicationSheet({ application: a, canWrite, onClose }: { application: Application | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [joinDate, setJoinDate] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function accept(ignoreDuplicates: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ memberId: string }>(`/applications/${a!.id}/accept`, { method: 'POST', body: { ignoreDuplicates, ...(joinDate ? { joinDate } : {}) } });
      navigate(`/mitglieder/${r.memberId}`);
      void qc.invalidateQueries({ queryKey: ['applications'] });
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    setBusy(true);
    try {
      await api('/applications/decide', { method: 'POST', body: { ids: [a!.id], action: 'reject', reason } });
      await qc.invalidateQueries({ queryKey: ['applications'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : 'Das hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={a ? `${a.data.firstName} ${a.data.lastName}` : 'Antrag'} open={!!a} onClose={() => { setMode(null); setError(undefined); onClose(); }}>
      {a && (
        <>
          <p className="meta" style={{ marginTop: 'calc(-1 * var(--s-3))', marginBottom: 'var(--s-4)' }}>{a.formTitle} · eingegangen {new Date(a.createdAt).toLocaleString('de-DE')}</p>
          {a.duplicates.length > 0 && (
            <div className="alert alert-warn" role="status">
              Vielleicht schon Mitglied: {a.duplicates.map((d, i) => <span key={d.memberId}>{i > 0 && ', '}<Link to={`/mitglieder/${d.memberId}`}>{d.name} ({d.number})</Link> – {d.reason}</span>)}
            </div>
          )}
          <dl className="facts">
            <dt>Geboren</dt><dd>{formatDate(a.data.birthDate)}{a.minor && ' (minderjährig)'}</dd>
            <dt>Anschrift</dt><dd>{a.data.street}<br />{a.data.postalCode} {a.data.city}</dd>
            <dt>E-Mail</dt><dd>{a.data.email}</dd>
            {a.data.phone && (<><dt>Telefon</dt><dd>{a.data.phone}</dd></>)}
            {a.data.guardian && (<><dt>Erziehungsberechtigt</dt><dd>{a.data.guardian.name}<div className="meta">{a.data.guardian.email}{a.data.guardian.phone && ` · ${a.data.guardian.phone}`}</div></dd></>)}
            <dt>Gruppen</dt><dd>{a.groups.map((g) => g.name).join(', ') || '—'}</dd>
            <dt>Beitrag</dt><dd>{a.feePlan?.name ?? '—'}</dd>
            <dt>Lastschrift</dt><dd>{a.data.mandate ? <>{a.data.mandate.accountHolder}<div className="meta">{a.data.mandate.iban}</div></> : 'nein'}</dd>
            {a.data.note && (<><dt>Anmerkung</dt><dd>{a.data.note}</dd></>)}
            <dt>Einwilligung</dt><dd className="meta">Version {a.consent.version}: {a.consent.text}</dd>
          </dl>
          {error && <div className="alert alert-error" role="alert" style={{ marginTop: 'var(--s-3)' }}>{error}</div>}
          {a.status === 'new' && canWrite && (
            mode === 'reject' ? (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void reject(); }}>
                <label htmlFor="rej">Begründung (geht an die antragstellende Person)</label>
                <input id="rej" className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-danger" disabled={busy || reason.trim().length < 3}>Ablehnen</button><button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>Abbrechen</button></div>
              </form>
            ) : (
              <>
                <div className="field" style={{ marginTop: 'var(--s-4)', maxWidth: 240 }}>
                  <label htmlFor="jd">Eintritt <span className="meta">(leer = nach Vereinsregel)</span></label>
                  <input id="jd" type="date" className="input" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} />
                </div>
                <div className="actions-row">
                  <button className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => void accept(a.duplicates.length > 0)}>{a.duplicates.length ? 'Trotzdem aufnehmen' : 'Aufnehmen'}</button>
                  <button className="btn" onClick={() => setMode('reject')}>Ablehnen …</button>
                </div>
              </>
            )
          )}
          {a.status === 'accepted' && a.memberId && <p><Link to={`/mitglieder/${a.memberId}`}>Zum Mitglied</Link></p>}
          {a.status === 'rejected' && a.reason && <p className="meta">Abgelehnt: {a.reason}</p>}
        </>
      )}
    </Sheet>
  );
}
