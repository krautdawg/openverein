import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { euro, PAYMENT_METHOD_LABEL, type FeeRun } from '../../shared/fees.ts';
import { Field } from '../components/Field.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal, useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';
import { FeesLayout } from './Fees.tsx';

type Summary = Omit<FeeRun, 'members'>;
const STATUS = { preview: 'Vorschau', posted: 'Gebucht', cancelled: 'Aufgehoben' } as const;

export function FeeRuns({ me }: { me: Me }) {
  useTitle('Beitragsläufe');
  const canWrite = me.permissions.fees === 'write' && me.permissions.invoices === 'write';
  const runs = useQuery({ queryKey: ['fee-runs'], queryFn: () => api<Summary[]>('/fee-runs') });
  const { data: groups } = useGroups();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const year = todayLocal().slice(0, 4);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    setBusy(true);
    try {
      const r = await api<FeeRun>('/fee-runs', { method: 'POST', body: { until: f.get('until'), issueDate: f.get('issueDate') || undefined, dueDate: f.get('dueDate') || undefined, groupId: f.get('groupId') || null } });
      navigate(`/beitraege/laeufe/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FeesLayout>
      {canWrite && (
        <form className="inline-form" style={{ marginTop: 0, marginBottom: 'var(--s-6)' }} onSubmit={create} noValidate aria-label="Neuer Beitragslauf">
          <h3>Neuer Beitragslauf</h3>
          <p className="meta" style={{ marginTop: 'calc(-1 * var(--s-2))' }}>Rechnet alle Zeiträume ab, die bis zum Stichtag beginnen. Du siehst erst eine Vorschau; gebucht wird nichts, bevor Du bestätigst.</p>
          {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
          <div className="form-row">
            <Field label="Abrechnen bis (Stichtag)" name="until" type="date" defaultValue={`${year}-12-31`} required error={error?.fieldError('until')} />
            <div className="field">
              <label htmlFor="run-group">Mitglieder</label>
              <select id="run-group" name="groupId" className="select" style={{ width: '100%' }}>
                <option value="">Alle</option>
                {groups?.map((g) => <option key={g.id} value={g.id}>nur {g.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <Field label="Rechnungsdatum" name="issueDate" type="date" defaultValue={todayLocal()} />
            <Field label="Fällig am" name="dueDate" type="date" hint="Leer lassen: Zahlungsziel aus den Einstellungen." error={error?.fieldError('dueDate')} />
          </div>
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary" aria-busy={busy} disabled={busy}>Vorschau erstellen</button></div>
        </form>
      )}
      <div className="table-wrap">
        {runs.data?.length === 0 ? (
          <div className="empty-state"><h3>Noch kein Beitragslauf.</h3><p>Ordne Mitgliedern Beitragsarten zu, dann erstellst Du hier die erste Vorschau.</p></div>
        ) : (
          <table className="table" aria-label="Beitragsläufe">
            <thead><tr><th scope="col">Erstellt</th><th scope="col">Bis</th><th scope="col">Status</th><th scope="col" className="num">Mitglieder</th><th scope="col" className="num">Summe</th><th scope="col" className="num hide-sm">Rechnungen</th></tr></thead>
            <tbody>
              {runs.data?.map((r) => (
                <tr key={r.id} data-href tabIndex={0} onClick={() => navigate(`/beitraege/laeufe/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/beitraege/laeufe/${r.id}`)}>
                  <td className="num">{new Date(r.createdAt).toLocaleDateString('de-DE')}</td>
                  <td className="num">{formatDate(r.until)}</td>
                  <td>{STATUS[r.status]}</td>
                  <td className="num">{r.totals.members}</td>
                  <td className="num">{euro(r.totals.totalCents)}</td>
                  <td className="num hide-sm">{r.invoiceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </FeesLayout>
  );
}

export function FeeRunDetail({ me }: { me: Me }) {
  const { id } = useParams();
  useTitle('Beitragslauf');
  const qc = useQueryClient();
  const canWrite = me.permissions.fees === 'write' && me.permissions.invoices === 'write';
  const run = useQuery({ queryKey: ['fee-run', id], queryFn: () => api<FeeRun>(`/fee-runs/${id}`) });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<'post' | 'cancel' | null>(null);
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const r = run.data;

  const included = useMemo(() => {
    if (!r) return { invoices: 0, total: 0 };
    let invoices = 0;
    let total = 0;
    for (const m of r.members) {
      const sum = m.lines.filter((l) => !excluded.has(l.key)).reduce((s, l) => s + l.amountCents, 0);
      if (sum > 0) invoices++;
      total += sum;
    }
    return { invoices, total };
  }, [r, excluded]);

  async function act(path: 'post' | 'cancel') {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api<FeeRun>(`/fee-runs/${id}/${path}`, { method: 'POST', body: path === 'post' ? { excludeLineKeys: [...excluded] } : {} });
      qc.setQueryData(['fee-run', id], next);
      void qc.invalidateQueries({ queryKey: ['fee-runs'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      setConfirming(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string) => setExcluded((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const withWarnings = r?.members.filter((m) => m.warnings.length > 0) ?? [];
  // Members with nothing new to bill only clutter the table; one summary line is enough.
  const alreadyBilled = r?.members.filter((m) => m.lines.length === 0 && m.skipped.every((x) => x.reason.includes('bereits'))) ?? [];
  const shown = r?.members.filter((m) => !alreadyBilled.includes(m)) ?? [];

  return (
    <FeesLayout>
      <p style={{ marginBottom: 'var(--s-4)' }}><Link to="/beitraege/laeufe">← Alle Beitragsläufe</Link></p>
      {!r && <div className="skeleton" style={{ width: '50%' }} />}
      {r && (
        <>
          <div className="page-head" style={{ marginBottom: 'var(--s-5)' }}>
            <div>
              <h2>{STATUS[r.status]}: abrechnen bis {formatDate(r.until)}</h2>
              <p>Rechnungsdatum {formatDate(r.issueDate)}, fällig am {formatDate(r.dueDate)}.</p>
            </div>
          </div>
          <dl className="figures" style={{ marginBottom: 'var(--s-6)' }}>
            <div><dt>Mitglieder</dt><dd>{r.totals.members}</dd></div>
            <div><dt>Positionen</dt><dd>{r.totals.lines}</dd></div>
            <div><dt>davon Nachberechnung</dt><dd>{r.totals.catchUpLines}</dd></div>
            <div><dt>Summe</dt><dd>{euro(r.status === 'preview' ? included.total : r.totals.totalCents)}</dd></div>
          </dl>

          {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-4)' }}><strong>{error.problem.title}</strong> {error.problem.detail}</div>}

          {r.status === 'preview' && canWrite && (
            <div className="bulkbar" style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)', padding: 'var(--s-3) var(--s-4)' }}>
              {confirming === 'post' ? (
                <>
                  <span>Jetzt {included.invoices} Rechnungen über {euro(included.total)} ausstellen? Das lässt sich nur mit Stornorechnungen rückgängig machen.</span>
                  <button className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => void act('post')}>Ja, buchen</button>
                  <button className="btn btn-ghost" onClick={() => setConfirming(null)}>Abbrechen</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1 }}>Prüfe die Vorschau. Abgewählte Positionen werden nicht berechnet und tauchen im nächsten Lauf wieder auf.</span>
                  <button className="btn btn-ghost" onClick={() => void act('cancel')}>Vorschau verwerfen</button>
                  <button className="btn btn-primary" disabled={included.invoices === 0} onClick={() => setConfirming('post')}>{included.invoices} Rechnungen buchen</button>
                </>
              )}
            </div>
          )}
          {r.status === 'posted' && (
            <div className="alert alert-ok" style={{ marginBottom: 'var(--s-4)', display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ flex: 1 }}>Gebucht am {new Date(r.postedAt!).toLocaleString('de-DE')}: {r.invoiceCount} Rechnungen.</span>
              <Link to={`/rechnungen?lauf=${r.id}`}>Rechnungen ansehen</Link>
              {canWrite && (confirming === 'cancel'
                ? <><span>Alle Rechnungen dieses Laufs stornieren?</span><button className="btn btn-danger" disabled={busy} onClick={() => void act('cancel')}>Ja, aufheben</button><button className="btn btn-ghost" onClick={() => setConfirming(null)}>Nein</button></>
                : <button className="btn" onClick={() => setConfirming('cancel')}>Lauf aufheben</button>)}
            </div>
          )}

          {withWarnings.length > 0 && (
            <section className="section" style={{ marginTop: 'var(--s-5)' }} aria-labelledby="w">
              <h2 id="w"><AlertTriangle size={18} aria-hidden style={{ verticalAlign: '-2px', color: 'var(--warn)' }} /> Hinweise ({withWarnings.length})</h2>
              <ul className="warnings">
                {withWarnings.map((m) => <li key={m.memberId}><Link to={`/mitglieder/${m.memberId}`}>{m.name}</Link>: {m.warnings.join(' ')}</li>)}
              </ul>
            </section>
          )}

          <div className="table-wrap" style={{ marginTop: 'var(--s-5)' }}>
            <table className="table" aria-label="Vorschau">
              <thead><tr><th scope="col">Mitglied</th><th scope="col">Position</th><th scope="col" className="hide-sm">Wie berechnet</th><th scope="col" className="num">Betrag</th></tr></thead>
              <tbody>
                {shown.map((m) => (
                  m.lines.length === 0 ? (
                    <tr key={m.memberId}>
                      <td className="name">{m.name}</td>
                      <td colSpan={3} className="muted">{m.skipped[0]?.reason ?? 'Nichts abzurechnen.'}</td>
                    </tr>
                  ) : m.lines.map((l, i) => (
                    <tr key={l.key} style={excluded.has(l.key) ? { opacity: 0.5 } : undefined}>
                      <td>{i === 0 && <><span className="name">{m.name}</span><div className="meta">Nr. {m.membershipNumber} · {PAYMENT_METHOD_LABEL[m.paymentMethod]}</div></>}</td>
                      <td>
                        {r.status === 'preview' && canWrite ? (
                          <label className="check" style={{ minHeight: 0 }}>
                            <input type="checkbox" checked={!excluded.has(l.key)} onChange={() => toggle(l.key)} aria-label={`${l.text} berechnen`} />
                            {l.text}
                          </label>
                        ) : l.text}
                        {l.catchUp && <span className="pill" style={{ marginLeft: 8 }}>Nachberechnung</span>}
                      </td>
                      <td className="hide-sm muted">{l.explanation}</td>
                      <td className="num">{euro(l.amountCents)}</td>
                    </tr>
                  ))
                ))}
              </tbody>
            </table>
          </div>
          {alreadyBilled.length > 0 && <p className="meta" style={{ marginTop: 'var(--s-3)' }}>{alreadyBilled.length} weitere Mitglieder sind bis zum Stichtag schon abgerechnet: {alreadyBilled.map((m) => m.name).join(', ')}.</p>}
        </>
      )}
    </FeesLayout>
  );
}
