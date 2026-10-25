import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { PageHead } from '../components/PageHead.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

type Side = { personId: string; memberId: string | null; name: string; membershipNumber: string | null; birthDate: string | null; email: string | null; street: string | null; postalCode: string | null; city: string | null };
type Pair = { score: number; matches: ('name' | 'birthDate' | 'email' | 'iban' | 'address')[]; a: Side; b: Side };

const label = (s: Side) => (s.membershipNumber ? `Nr. ${s.membershipNumber}` : s.name);
const problemText = (e: unknown) => (e instanceof ApiError ? [e.problem.title, e.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');

function Person({ s, matches }: { s: Side; matches: Pair['matches'] }) {
  const hit = (k: Pair['matches'][number], v: string | null) => (v ? (matches.includes(k) ? <mark className="match">{v}</mark> : v) : <span className="muted">–</span>);
  return (
    <dl className="facts">
      <dt>Name</dt><dd>{s.memberId ? <Link to={`/mitglieder/${s.memberId}`}>{hit('name', s.name)}</Link> : hit('name', s.name)}{s.membershipNumber && <span className="meta"> · Nr. {s.membershipNumber}</span>}</dd>
      <dt>Geboren</dt><dd>{hit('birthDate', s.birthDate && formatDate(s.birthDate))}</dd>
      <dt>E-Mail</dt><dd>{hit('email', s.email)}</dd>
      <dt>Anschrift</dt><dd>{hit('address', [s.street, [s.postalCode, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null)}</dd>
    </dl>
  );
}

export function Duplicates({ me }: { me: Me }) {
  useTitle('Dubletten');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const threshold = Number(params.get('ab') ?? 80);
  const list = useQuery({ queryKey: ['duplicates', threshold], queryFn: () => api<Pair[]>(`/members/duplicates?threshold=${threshold}`) });
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const canWrite = me.permissions.members === 'write';

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMessage(undefined);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      await qc.invalidateQueries({ queryKey: ['duplicates'] });
      void qc.invalidateQueries({ queryKey: ['members'] });
    } catch (err) {
      setMessage({ ok: false, text: problemText(err) });
    }
  }

  return (
    <div className="page">
      <p style={{ marginBottom: 'var(--s-4)' }}><Link to="/mitglieder">← Mitglieder</Link></p>
      <PageHead title="Dubletten" intro="Personen, die vermutlich doppelt erfasst sind. Übereinstimmungen sind markiert. Archiviert wird nur, wer keine Rechnungen, Mandate oder Spenden hat." />
      <div className="toolbar">
        <label htmlFor="threshold">Ab {threshold} % Übereinstimmung</label>
        <input id="threshold" type="range" min={60} max={100} step={5} value={threshold} onChange={(e) => setParams({ ab: e.target.value })} style={{ width: 200 }} />
      </div>
      {message && <div className={`alert ${message.ok ? 'alert-ok' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'} style={{ marginBottom: 'var(--s-4)' }}>{message.text}</div>}
      {list.error && <div className="alert alert-error" role="alert">{problemText(list.error)}</div>}
      {list.data?.length === 0 && <p className="empty">Keine möglichen Dubletten ab {threshold} %.</p>}
      <ul className="dup-list" aria-label="Mögliche Dubletten">
        {list.data?.map((p) => (
          <li key={`${p.a.personId}-${p.b.personId}`} className="dup">
            <div className="dup-score"><strong>{p.score} %</strong></div>
            <div className="dup-pair">
              <Person s={p.a} matches={p.matches} />
              <Person s={p.b} matches={p.matches} />
            </div>
            {canWrite && (
              <div className="actions-row" style={{ marginTop: 0 }}>
                <button className="btn btn-ghost" onClick={() => void run(() => api('/members/duplicates/dismiss', { method: 'POST', body: { personA: p.a.personId, personB: p.b.personId } }), 'Gemerkt: keine Dublette.')}>Keine Dublette</button>
                <button className="btn" onClick={() => void run(() => api('/members/duplicates/resolve', { method: 'POST', body: { keepPersonId: p.a.personId, archivePersonId: p.b.personId } }), `${p.b.name} archiviert.`)}>{label(p.b)} archivieren</button>
                <button className="btn" onClick={() => void run(() => api('/members/duplicates/resolve', { method: 'POST', body: { keepPersonId: p.b.personId, archivePersonId: p.a.personId } }), `${p.a.name} archiviert.`)}>{label(p.a)} archivieren</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
