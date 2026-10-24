import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import { Download, Upload } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { euro } from '../../shared/fees.ts';
import { READINESS_LABEL, RUN_STATUS_LABEL, type BankAccount, type BankTx, type Candidate, type Run } from '../../shared/sepa.ts';
import { Field } from '../components/Field.tsx';
import { MoneyField } from '../components/MoneyField.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

const RETURN_TEXT: Record<string, string> = { AC01: 'IBAN fehlerhaft', AC04: 'Konto erloschen', AC06: 'Konto gesperrt', AM04: 'Konto nicht gedeckt', MD01: 'Kein gültiges Mandat', MD06: 'Widerspruch durch Zahler', MD07: 'Kontoinhaber verstorben', MS02: 'Widerspruch durch Zahler', MS03: 'Ohne Angabe von Gründen' };

export function BankLayout({ me, children }: { me: Me; children: React.ReactNode }) {
  return (
    <div className="page">
      <PageHead title="Bank" intro="Kontoauszüge einlesen, Zahlungen zuordnen und SEPA-Lastschriften erzeugen. Die Dateien lädst Du selbst im Online-Banking hoch." />
      <nav className="subnav" aria-label="Bank">
        {me.permissions.banking !== 'none' && <NavLink to="/bank" end>Konten</NavLink>}
        {me.permissions.banking !== 'none' && <NavLink to="/bank/abgleich">Abgleich</NavLink>}
        {me.permissions.sepa !== 'none' && <NavLink to="/bank/lastschriften">Lastschriften</NavLink>}
      </nav>
      {children}
    </div>
  );
}

function errText(e: unknown) {
  return e instanceof ApiError ? [e.problem.title, e.problem.detail].filter(Boolean).join(' ') : String(e);
}

// ---------- Accounts and import ----------

export function BankAccounts({ me }: { me: Me }) {
  useTitle('Bankkonten');
  const qc = useQueryClient();
  const canWrite = me.permissions.banking === 'write';
  const accounts = useQuery({ queryKey: ['bank-accounts'], queryFn: () => api<BankAccount[]>('/bank-accounts') });
  const imports = useQuery({ queryKey: ['bank-imports'], queryFn: () => api<{ id: string; bankAccountId: string; fileName: string | null; periodFrom: string | null; periodTo: string | null; transactionCount: number; createdAt: string }[]>('/bank-imports') });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string>();
  const [pending, setPending] = useState<{ file: File; message: string } | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/bank-accounts', { method: 'POST', body: { name: f.get('name'), iban: f.get('iban'), bic: f.get('bic') || null, openingDate: f.get('openingDate'), openingBalanceCents: Number(f.get('openingBalanceCents') || 0) } });
      await qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      setAdding(false);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  async function upload(file: File, balanceOverrideReason?: string) {
    if (!target) return;
    setBusy(true);
    setResult(undefined);
    setPending(null);
    try {
      const content = await file.text();
      const format = /<\?xml|<Document/i.test(content.slice(0, 500)) ? 'camt053' : 'csv';
      const r = await api<{ imported: number; duplicates: number; autoMatched: number; returns: number; warnings: string[] }>(`/bank-accounts/${target}/imports`, { method: 'POST', body: { format, fileName: file.name, content, balanceOverrideReason } });
      setResult(`${r.imported} Buchungen eingelesen${r.duplicates ? `, ${r.duplicates} doppelte übersprungen` : ''}. ${r.autoMatched} automatisch zugeordnet${r.returns ? `, ${r.returns} Rücklastschriften verbucht` : ''}.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['bank-accounts'] }), qc.invalidateQueries({ queryKey: ['bank-imports'] }), qc.invalidateQueries({ queryKey: ['bank-tx'] }), qc.invalidateQueries({ queryKey: ['invoices'] })]);
    } catch (err) {
      if (err instanceof ApiError && err.problem.type.endsWith('/balance-mismatch')) setPending({ file, message: errText(err) });
      else setResult(errText(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function rollback(id: string) {
    try {
      await api(`/bank-imports/${id}`, { method: 'DELETE' });
      await Promise.all([qc.invalidateQueries({ queryKey: ['bank-imports'] }), qc.invalidateQueries({ queryKey: ['bank-accounts'] })]);
    } catch (err) {
      setResult(errText(err));
    }
  }

  return (
    <BankLayout me={me}>
      <input ref={fileRef} type="file" accept=".xml,.csv,.txt" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} aria-label="Kontoauszug auswählen" />
      {result && <div className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-4)' }}>{result}{' '}<Link to="/bank/abgleich">Zum Abgleich</Link></div>}
      {pending && (
        <form className="inline-form" style={{ marginTop: 0, marginBottom: 'var(--s-4)' }} onSubmit={(e) => { e.preventDefault(); void upload(pending.file, String(new FormData(e.currentTarget).get('reason'))); }}>
          <div className="alert alert-warn" role="alert">{pending.message}</div>
          <Field label="Trotzdem einlesen, weil …" name="reason" required minLength={3} placeholder="z. B. der Auszug vom Vormonat fehlt noch" />
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Mit Begründung einlesen</button><button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>Abbrechen</button></div>
        </form>
      )}
      <div className="table-wrap">
        {accounts.data?.length === 0 ? (
          <div className="empty-state">
            <h3>Noch kein Bankkonto.</h3>
            <p>Leg das Vereinskonto mit Anfangssaldo an. Danach liest Du Kontoauszüge als CAMT-Datei (XML) oder CSV aus dem Online-Banking ein.</p>
          </div>
        ) : (
          <table className="table" aria-label="Bankkonten">
            <thead><tr><th scope="col">Konto</th><th scope="col" className="hide-sm">IBAN</th><th scope="col" className="num">Saldo</th><th scope="col" className="num hide-sm">Letzte Buchung</th><th scope="col" className="num">Offen</th><th scope="col" /></tr></thead>
            <tbody>
              {accounts.data?.map((a) => (
                <tr key={a.id}>
                  <td className="name">{a.name}</td>
                  <td className="hide-sm num">{a.iban.replace(/(.{4})/g, '$1 ')}</td>
                  <td className="num">{euro(a.balanceCents)}</td>
                  <td className="num hide-sm">{formatDate(a.lastBookingDate) || '—'}</td>
                  <td className="num">{a.unmatched > 0 ? <Link to="/bank/abgleich">{a.unmatched}</Link> : '—'}</td>
                  <td className="r">{canWrite && <button className="btn" aria-busy={busy && target === a.id} onClick={() => { setTarget(a.id); fileRef.current?.click(); }}><Upload size={16} aria-hidden /> Auszug einlesen</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {canWrite && !adding && <div className="actions-row"><button className="btn" onClick={() => setAdding(true)}>Bankkonto anlegen</button></div>}
      {adding && (
        <form className="inline-form" noValidate onSubmit={create} aria-label="Neues Bankkonto">
          {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
          <div className="form-row">
            <Field label="Name" name="name" defaultValue="Vereinskonto" />
            <Field label="IBAN" name="iban" error={error?.fieldError('iban')} />
          </div>
          <div className="form-row">
            <Field label="BIC (optional)" name="bic" error={error?.fieldError('bic')} />
            <Field label="Saldo am" name="openingDate" type="date" defaultValue={`${todayLocal().slice(0, 4)}-01-01`} />
          </div>
          <MoneyField label="Anfangssaldo" name="openingBalanceCents" defaultCents={0} />
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Anlegen</button><button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Abbrechen</button></div>
        </form>
      )}
      {imports.data && imports.data.length > 0 && (
        <section className="section" aria-labelledby="imp">
          <h2 id="imp">Eingelesene Auszüge</h2>
          <ol className="timeline">
            {imports.data.map((i) => (
              <li key={i.id} style={{ gridTemplateColumns: '6.5rem 1fr auto' }}>
                <time>{new Date(i.createdAt).toLocaleDateString('de-DE')}</time>
                <span>{i.fileName ?? 'Auszug'} <span className="muted">· {i.transactionCount} Buchungen{i.periodFrom && ` · ${formatDate(i.periodFrom)}–${formatDate(i.periodTo)}`}</span></span>
                {canWrite && <button className="btn btn-ghost" onClick={() => void rollback(i.id)}>Zurückrollen</button>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </BankLayout>
  );
}

// ---------- Reconciliation inbox ----------

export function Reconciliation({ me }: { me: Me }) {
  useTitle('Abgleich');
  const qc = useQueryClient();
  const canWrite = me.permissions.banking === 'write' && me.permissions.invoices === 'write';
  const [status, setStatus] = useState<'unmatched' | 'matched' | 'ignored'>('unmatched');
  const txs = useQuery({ queryKey: ['bank-tx', status], queryFn: () => api<BankTx[]>(`/bank-transactions?status=${status}`) });
  const [message, setMessage] = useState<string>();
  const [open, setOpen] = useState<string | null>(null);

  async function act(path: string, body: unknown) {
    setMessage(undefined);
    try {
      await api(path, { method: 'POST', body });
      await Promise.all([qc.invalidateQueries({ queryKey: ['bank-tx'] }), qc.invalidateQueries({ queryKey: ['invoices'] }), qc.invalidateQueries({ queryKey: ['bank-accounts'] })]);
      setOpen(null);
    } catch (err) {
      setMessage(errText(err));
    }
  }

  return (
    <BankLayout me={me}>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Ansicht">
          {(['unmatched', 'matched', 'ignored'] as const).map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{{ unmatched: 'Offen', matched: 'Zugeordnet', ignored: 'Abgehakt' }[s]}</button>)}
        </div>
        <span style={{ flex: 1 }} />
        {canWrite && status === 'unmatched' && <button className="btn" onClick={() => void act('/bank-transactions/match', {})}>Automatisch abgleichen</button>}
      </div>
      {message && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-3)' }}>{message}</div>}
      <div className="table-wrap">
        {txs.data?.length === 0 ? (
          <div className="empty-state"><h3>{status === 'unmatched' ? 'Alles abgeglichen.' : 'Keine Buchungen.'}</h3><p>{status === 'unmatched' ? 'Jede eingelesene Buchung ist einer Rechnung zugeordnet oder abgehakt.' : 'Hier erscheinen Buchungen, sobald Du Auszüge einliest.'}</p></div>
        ) : (
          <table className="table" aria-label="Kontobewegungen">
            <thead><tr><th scope="col" className="num">Datum</th><th scope="col">Von / an</th><th scope="col" className="hide-sm">Verwendungszweck</th><th scope="col" className="num">Betrag</th><th scope="col">{status === 'unmatched' ? 'Vorschlag' : 'Zuordnung'}</th></tr></thead>
            <tbody>
              {txs.data?.map((t) => (
                <TxRow key={t.id} t={t} canWrite={canWrite} expanded={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} act={act} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </BankLayout>
  );
}

function TxRow({ t, canWrite, expanded, onToggle, act }: { t: BankTx; canWrite: boolean; expanded: boolean; onToggle: () => void; act: (path: string, body: unknown) => Promise<void> }) {
  const best = t.suggestions[0];
  // One click only for a confident suggestion that settles the invoice exactly.
  const oneClick = best && best.score >= 75 && best.openCents === t.amountCents;
  return (
    <>
      <tr>
        <td className="num" style={{ whiteSpace: 'nowrap' }}>{formatDate(t.bookingDate)}</td>
        <td>
          <span className="name">{t.counterpartyName ?? '—'}</span>
          {t.counterpartyIbanMasked && <div className="meta">{t.counterpartyIbanMasked}</div>}
          {t.returnReason && <div className="meta" style={{ color: 'var(--danger)' }}>Rücklastschrift: {RETURN_TEXT[t.returnReason] ?? t.returnReason}</div>}
        </td>
        <td className="hide-sm muted" style={{ maxWidth: 320 }}>{t.remittance}</td>
        <td className="num" style={{ color: t.amountCents < 0 ? 'var(--danger)' : undefined }}>{euro(t.amountCents)}</td>
        <td>
          {t.status === 'matched' && (
            <>
              {t.allocations.map((a) => <div key={a.invoiceId}><Link to={`/rechnungen/${a.invoiceId}`}>{a.number}</Link> <span className="muted num">{euro(a.amountCents)}</span></div>)}
              {t.allocations.length === 0 && <span className="muted">Rücklastschrift verbucht</span>}
              {canWrite && t.allocations.length > 0 && <button className="btn btn-ghost" onClick={() => void act(`/bank-transactions/${t.id}/unmatch`, {})}>Aufheben</button>}
            </>
          )}
          {t.status === 'ignored' && <span className="muted">{t.note}</span>}
          {t.status === 'unmatched' && canWrite && (
            <div className="inline-edit" style={{ flexWrap: 'wrap' }}>
              {best && oneClick && <button className="btn btn-primary" title={best.rule} onClick={() => void act(`/bank-transactions/${t.id}/allocate`, { allocations: [{ invoiceId: best.invoiceId, amountCents: t.amountCents }] })}>{best.number} zuordnen</button>}
              <button className="btn btn-ghost" aria-expanded={expanded} onClick={onToggle}>{best && oneClick ? 'Andere …' : 'Zuordnen …'}</button>
            </div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface-sunk)', padding: 'var(--s-4)' }}>
            <TxActions t={t} act={act} />
          </td>
        </tr>
      )}
    </>
  );
}

function TxActions({ t, act }: { t: BankTx; act: (path: string, body: unknown) => Promise<void> }) {
  const [invoice, setInvoice] = useState(t.suggestions[0]?.invoiceId ?? '');
  return (
    <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
      {t.amountCents > 0 && (
        <form className="inline-edit" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void act(`/bank-transactions/${t.id}/allocate`, { allocations: [{ invoiceId: invoice, amountCents: t.amountCents }] }); }}>
          <label htmlFor={`inv-${t.id}`}>Rechnung</label>
          <select id={`inv-${t.id}`} className="select" value={invoice} onChange={(e) => setInvoice(e.target.value)}>
            <option value="">Bitte wählen</option>
            {t.suggestions.map((s) => <option key={s.invoiceId} value={s.invoiceId}>{s.number} · {s.recipientName} · offen {euro(s.openCents)} ({s.rule})</option>)}
          </select>
          <button className="btn btn-primary" disabled={!invoice}>Ganzen Betrag zuordnen</button>
          <span className="meta">Andere Rechnung? Trag die Zahlung dort von Hand ein und hake diese Buchung ab.</span>
        </form>
      )}
      {t.amountCents < 0 && (
        <form className="inline-edit" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void act(`/bank-transactions/${t.id}/return`, { endToEndId: new FormData(e.currentTarget).get('e2e') }); }}>
          <label htmlFor={`e2e-${t.id}`}>Rücklastschrift zu Einzugsposition</label>
          <input id={`e2e-${t.id}`} name="e2e" className="input" style={{ width: 220 }} placeholder="End-to-End-Referenz (OV…)" defaultValue={t.endToEndId ?? ''} />
          <button className="btn">Als Rücklastschrift buchen</button>
        </form>
      )}
      <form className="inline-edit" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void act(`/bank-transactions/${t.id}/ignore`, { note: new FormData(e.currentTarget).get('note') }); }}>
        <label htmlFor={`note-${t.id}`}>Ohne Rechnung abhaken</label>
        <input id={`note-${t.id}`} name="note" className="input" style={{ width: 260 }} placeholder="z. B. Kontoführungsgebühr" required minLength={2} />
        <button className="btn">Abhaken</button>
      </form>
    </div>
  );
}

// ---------- Direct debits ----------

export function Collections({ me }: { me: Me }) {
  useTitle('Lastschriften');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canWrite = me.permissions.sepa === 'write';
  const [kind, setKind] = useState<'debit' | 'transfer'>('debit');
  const candidates = useQuery({ queryKey: ['candidates', kind], queryFn: () => api<Candidate[]>(`/collection-runs/candidates?kind=${kind}`) });
  const runs = useQuery({ queryKey: ['collection-runs'], queryFn: () => api<Omit<Run, 'items' | 'files'>[]>('/collection-runs') });
  const accounts = useQuery({ queryKey: ['bank-accounts'], queryFn: () => api<BankAccount[]>('/bank-accounts'), enabled: me.permissions.banking !== 'none' });
  const ready = useMemo(() => (candidates.data ?? []).filter((c) => c.readiness === 'ok'), [candidates.data]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const chosen = ready.filter((c) => !excluded.has(c.invoiceId));
  const latestDue = chosen.map((c) => c.dueDate ?? '').sort().at(-1) ?? '';
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<Run>('/collection-runs', { method: 'POST', body: { kind, bankAccountId: f.get('account'), collectionDate: f.get('date'), invoiceIds: chosen.map((c) => c.invoiceId) } });
      await qc.invalidateQueries({ queryKey: ['candidates'] });
      navigate(`/bank/lastschriften/${r.id}`);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BankLayout me={me}>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Art">
          <button aria-pressed={kind === 'debit'} onClick={() => setKind('debit')}>Lastschriften einziehen</button>
          <button aria-pressed={kind === 'transfer'} onClick={() => setKind('transfer')}>Gutschriften überweisen</button>
        </div>
      </div>
      <div className="table-wrap">
        {candidates.data?.length === 0 ? (
          <div className="empty-state"><h3>Nichts offen.</h3><p>{kind === 'debit' ? 'Offene Rechnungen von Mitgliedern mit Zahlungsart Lastschrift erscheinen hier.' : 'Offene Gutschriften erscheinen hier.'}</p></div>
        ) : (
          <table className="table" aria-label="Offene Posten">
            <thead><tr><th scope="col" className="cb" /><th scope="col">Rechnung</th><th scope="col">Empfänger:in</th><th scope="col" className="num hide-sm">Fällig</th><th scope="col" className="num">Betrag</th><th scope="col">Bereit?</th></tr></thead>
            <tbody>
              {candidates.data?.map((c) => (
                <tr key={c.invoiceId} aria-selected={c.readiness === 'ok' && !excluded.has(c.invoiceId)}>
                  <td className="cb">{c.readiness === 'ok' && canWrite && <input type="checkbox" aria-label={`${c.number} einziehen`} checked={!excluded.has(c.invoiceId)} onChange={() => setExcluded((s) => { const n = new Set(s); if (n.has(c.invoiceId)) n.delete(c.invoiceId); else n.add(c.invoiceId); return n; })} />}</td>
                  <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}><Link to={`/rechnungen/${c.invoiceId}`}>{c.number}</Link></td>
                  <td>{c.memberId ? <Link to={`/mitglieder/${c.memberId}`}>{c.recipientName}</Link> : c.recipientName}{c.mandateReference && <div className="meta">Mandat {c.mandateReference}</div>}</td>
                  <td className="num hide-sm">{formatDate(c.dueDate)}</td>
                  <td className="num">{euro(c.openCents)}</td>
                  <td><span className="status" title={READINESS_LABEL[c.readiness]} data-s={c.readiness === 'ok' ? 'active' : c.readiness === 'in_run' ? 'future' : 'applicant'}><span className="label-sm">{READINESS_LABEL[c.readiness]}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {canWrite && ready.length > 0 && (
        <form className="inline-form" onSubmit={create} aria-label="Einzug erstellen">
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <div className="form-row">
            <div className="field">
              <label htmlFor="acc">{kind === 'debit' ? 'Gutschrift auf' : 'Überweisen von'}</label>
              <select id="acc" name="account" className="select" style={{ width: '100%' }} required>
                {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <Field label={kind === 'debit' ? 'Einzugsdatum' : 'Ausführungsdatum'} name="date" type="date" required defaultValue={latestDue > todayLocal() ? latestDue : undefined} hint={kind === 'debit' ? 'Ein Bankarbeitstag, frühestens 2 Bankarbeitstage nach heute und nicht vor der Fälligkeit (Vorabankündigung auf der Rechnung).' : undefined} />
          </div>
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary" aria-busy={busy} disabled={busy || chosen.length === 0}>{kind === 'debit' ? 'Lastschriftdatei' : 'Überweisungsdatei'} für {chosen.length} Posten über {euro(chosen.reduce((s, c) => s + c.openCents, 0))} erzeugen</button>
          </div>
          {accounts.data?.length === 0 && <p className="meta">Lege zuerst unter „Konten“ ein Bankkonto an.</p>}
        </form>
      )}
      {runs.data && runs.data.length > 0 && (
        <section className="section" aria-labelledby="runs">
          <h2 id="runs">Erzeugte Dateien</h2>
          <div className="table-wrap">
            <table className="table" aria-label="Einzüge">
              <thead><tr><th scope="col" className="num">Datum</th><th scope="col" className="hide-sm">Art</th><th scope="col">Status</th><th scope="col" className="num">Posten</th><th scope="col" className="num">Summe</th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id} data-href tabIndex={0} onClick={() => navigate(`/bank/lastschriften/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/bank/lastschriften/${r.id}`)}>
                    <td className="num">{formatDate(r.collectionDate)}</td>
                    <td className="hide-sm">{r.kind === 'debit' ? 'Lastschrift' : 'Überweisung'}</td>
                    <td>{RUN_STATUS_LABEL[r.status]}</td>
                    <td className="num">{r.itemCount}</td>
                    <td className="num">{euro(r.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </BankLayout>
  );
}

export function CollectionRunDetail({ me }: { me: Me }) {
  useTitle('Einzug');
  const { id } = useParams();
  const qc = useQueryClient();
  const canWrite = me.permissions.sepa === 'write';
  const run = useQuery({ queryKey: ['collection-run', id], queryFn: () => api<Run>(`/collection-runs/${id}`) });
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string>();
  const r = run.data;

  async function act(path: string, body: unknown = {}) {
    setError(undefined);
    try {
      qc.setQueryData(['collection-run', id], await api<Run>(`/collection-runs/${id}/${path}`, { method: 'POST', body }));
      void qc.invalidateQueries({ queryKey: ['collection-runs'] });
      void qc.invalidateQueries({ queryKey: ['candidates'] });
      setReleasing(false);
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <BankLayout me={me}>
      <p style={{ marginBottom: 'var(--s-4)' }}><Link to="/bank/lastschriften">← Lastschriften</Link></p>
      {r && (
        <>
          <div className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
            <div>
              <h2>{r.kind === 'debit' ? 'Lastschrifteinzug' : 'Überweisungen'} zum {formatDate(r.collectionDate)}</h2>
              <p>{RUN_STATUS_LABEL[r.status]} · {r.itemCount} Posten · {euro(r.totalCents)} · {r.bankAccountName}</p>
            </div>
          </div>
          {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-3)' }}>{error}</div>}
          <section aria-labelledby="files">
            <h3 id="files" style={{ marginBottom: 'var(--s-2)' }}>Dateien für das Online-Banking</h3>
            <ol className="timeline">
              {r.files.map((f) => (
                <li key={f.position} style={{ gridTemplateColumns: '1fr auto' }}>
                  <span>
                    <span className="num">{f.messageId}</span> <span className="muted">· {f.sequenceType ?? 'SCT'} · {f.itemCount} Posten · {euro(f.controlSumCents)}</span>
                    <div className="meta">SHA-256 {f.sha256.slice(0, 16)}… {f.downloadedAt ? `· heruntergeladen ${new Date(f.downloadedAt).toLocaleString('de-DE')}` : '· noch nicht heruntergeladen'}</div>
                  </span>
                  {r.status !== 'released' && <a className="btn" href={`/api/v1/collection-runs/${r.id}/files/${f.position}`} download onClick={() => setTimeout(() => void run.refetch(), 800)}><Download size={16} aria-hidden /> XML</a>}
                </li>
              ))}
            </ol>
          </section>
          {canWrite && ['generated', 'downloaded', 'submitted'].includes(r.status) && (
            <div className="actions-row">
              {r.status !== 'submitted' && <button className="btn btn-primary" onClick={() => void act('submitted')}>Bei der Bank eingereicht</button>}
              {!releasing && <button className="btn btn-ghost btn-danger" onClick={() => setReleasing(true)}>Freigeben …</button>}
            </div>
          )}
          {releasing && (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act('release', { reason: f.get('reason'), confirmNotSubmitted: f.get('confirm') === 'on' }); }}>
              <p>Freigeben macht die Rechnungen wieder einziehbar. Wurde die Datei schon bei der Bank eingereicht, käme es zu einer doppelten Abbuchung.</p>
              <Field label="Grund" name="reason" required placeholder="z. B. falsches Einzugsdatum" />
              {r.status !== 'generated' && <label className="check"><input type="checkbox" name="confirm" required /> Ich bestätige: Die Datei wurde nie bei der Bank eingereicht und ist gelöscht.</label>}
              <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-danger">Freigeben</button><button type="button" className="btn btn-ghost" onClick={() => setReleasing(false)}>Abbrechen</button></div>
            </form>
          )}
          <div className="table-wrap" style={{ marginTop: 'var(--s-5)' }}>
            <table className="table" aria-label="Posten">
              <thead><tr><th scope="col">Name</th><th scope="col" className="hide-sm">Rechnungen</th><th scope="col" className="hide-sm">Referenz</th><th scope="col" className="num">Betrag</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.id}>
                    <td className="name">{i.name}{i.mandateReference && <div className="meta">Mandat {i.mandateReference}</div>}</td>
                    <td className="hide-sm">{i.invoiceNumbers.join(', ')}</td>
                    <td className="hide-sm meta" style={{ fontVariantNumeric: 'tabular-nums' }}>{i.endToEndId}</td>
                    <td className="num">{euro(i.amountCents)}</td>
                    <td><span className="status" data-s={{ included: 'future', settled: 'active', returned: 'rejected', withdrawn: 'former' }[i.status]}>{{ included: 'Im Einzug', settled: 'Gutgeschrieben', returned: 'Zurückgegeben', withdrawn: 'Zurückgezogen' }[i.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </BankLayout>
  );
}
