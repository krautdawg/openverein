import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import { ALLOWANCE_LABEL, type AllowanceKind } from '../../shared/allowances.ts';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { Field } from '../components/Field.tsx';
import { MoneyField } from '../components/MoneyField.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';
import { LedgerLayout } from './Ledger.tsx';

interface Row { personId: string; name: string; kind: AllowanceKind; paidCents: number; otherCents: number; limitCents: number; remainingCents: number; payments: { id: string; paidOn: string; amountCents: number; text: string }[] }
const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const problemText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');

/** Übungsleiter- and Ehrenamtspauschale per person and year against the tax-free limits. */
export function Allowances({ me }: { me: Me }) {
  useTitle('Pauschalen');
  const [params, setParams] = useSearchParams();
  const thisYear = new Date().getFullYear();
  const year = Number(params.get('jahr') ?? thisYear);
  const rows = useQuery({ queryKey: ['allowances', year], queryFn: () => api<Row[]>(`/allowances?year=${year}`) });
  const [adding, setAdding] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <LedgerLayout me={me} action={<button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> Pauschale erfassen</button>}>
      <p className="muted" style={{ maxWidth: '72ch', marginBottom: 'var(--s-4)' }}>Steuerfreie Übungsleiter- und Ehrenamtspauschalen je Person und Jahr. Die Grenzen gelten für alle Vereine zusammen; was die Person anderswo bekommt, trägst Du als Erklärung ein. Die Auszahlung buchst Du wie jede Ausgabe.</p>
      <div className="toolbar">
        <select className="select" aria-label="Jahr" value={year} onChange={(e) => setParams({ jahr: e.target.value }, { replace: true })}>
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {warning && <div className="alert alert-warn" role="status" style={{ marginBottom: 'var(--s-3)' }}>{warning}</div>}
      <div className="table-wrap">
        {rows.data?.length === 0 ? <p className="empty">Keine Pauschalen in {year}.</p> : (
          <table className="table" aria-label={`Pauschalen ${year}`}>
            <thead><tr><th scope="col">Person</th><th scope="col">Art</th><th scope="col" className="num">Gezahlt</th><th scope="col" className="num hide-sm">Anderswo</th><th scope="col" className="num hide-sm">Grenze</th><th scope="col" className="num">Rest</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
            <tbody>
              {rows.data?.map((r) => (
                <tr key={`${r.personId}-${r.kind}`}>
                  <td>{r.name}</td>
                  <td>{r.kind === 'uebungsleiter' ? 'Übungsleiter' : 'Ehrenamt'}</td>
                  <td className="num">{euro(r.paidCents)}</td>
                  <td className="num hide-sm">{euro(r.otherCents)}</td>
                  <td className="num hide-sm">{euro(r.limitCents)}</td>
                  <td className="num" data-over={r.remainingCents < 0 || undefined}>{r.remainingCents < 0 ? `${euro(-r.remainingCents)} über` : euro(r.remainingCents)}</td>
                  <td><button className="btn btn-ghost" aria-label={`${ALLOWANCE_LABEL[r.kind]} von ${r.name}`} onClick={() => setOpen(r)}>Details …</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddPayment onClose={() => setAdding(false)} onWarning={setWarning} />}
      {open && <Details row={open} year={year} onClose={() => setOpen(null)} />}
    </LedgerLayout>
  );
}

function AddPayment({ onClose, onWarning }: { onClose: () => void; onWarning: (w: string | null) => void }) {
  const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const [person, setPerson] = useState<MemberListItem | null>(null);
  const found = useQuery({ queryKey: ['allowance-person', term], queryFn: () => api<{ items: MemberListItem[] }>(`/members?q=${encodeURIComponent(term)}&limit=8`), enabled: term.trim().length >= 2 && !person });
  const [error, setError] = useState<ApiError>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      const r = await api<{ warning: string | null }>('/allowances/payments', { method: 'POST', body: { personId: person?.personId, kind: f.get('kind'), paidOn: f.get('paidOn'), amountCents: Number(f.get('amountCents')), text: f.get('text') } });
      onWarning(r.warning);
      await qc.invalidateQueries({ queryKey: ['allowances'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  return (
    <Sheet title="Pauschale erfassen" open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{problemText(error)}</div>}
        {person ? (
          <div className="field"><span className="label">Person</span><div className="inline-edit">{displayName(person)} <button type="button" className="btn btn-ghost" onClick={() => setPerson(null)}>ändern</button></div></div>
        ) : (
          <div className="field">
            <label htmlFor="al-pick">Person suchen</label>
            <input id="al-pick" className="input" autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name oder Nummer" />
            <ul className="timeline">{found.data?.items.map((m) => <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}><span>{displayName(m)}</span><button type="button" className="btn btn-ghost" aria-label={`${displayName(m)} wählen`} onClick={() => setPerson(m)}>wählen</button></li>)}</ul>
          </div>
        )}
        <div className="field">
          <label htmlFor="al-kind">Art</label>
          <select id="al-kind" name="kind" className="select"><option value="uebungsleiter">{ALLOWANCE_LABEL.uebungsleiter}</option><option value="ehrenamt">{ALLOWANCE_LABEL.ehrenamt}</option></select>
        </div>
        <div className="form-row">
          <Field label="Gezahlt am" name="paidOn" type="date" defaultValue={todayLocal()} error={error?.fieldError('paidOn')} />
          <MoneyField label="Betrag" name="amountCents" error={error?.fieldError('amountCents')} />
        </div>
        <Field label="Wofür" name="text" placeholder="z. B. Training Jugend, 1. Quartal" error={error?.fieldError('text')} />
        <div className="actions-row"><button className="btn btn-primary" disabled={!person}>Erfassen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

function Details({ row, year, onClose }: { row: Row; year: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  async function declare(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/allowances/declarations', { method: 'PUT', body: { personId: row.personId, year, kind: row.kind, otherCents: Number(f.get('otherCents')), declaredOn: f.get('declaredOn') } });
      await qc.invalidateQueries({ queryKey: ['allowances'] });
      setSaved(true);
    } catch (err) {
      setError(problemText(err));
    }
  }
  async function remove(id: string) {
    await api(`/allowances/payments/${id}`, { method: 'DELETE' }).catch((err: unknown) => setError(problemText(err)));
    await qc.invalidateQueries({ queryKey: ['allowances'] });
    onClose();
  }
  return (
    <Sheet title={`${ALLOWANCE_LABEL[row.kind]} ${year}: ${row.name}`} open onClose={onClose}>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <ul className="timeline" aria-label="Zahlungen">
        {row.payments.map((p) => (
          <li key={p.id} style={{ gridTemplateColumns: '6rem 1fr auto auto' }}>
            <span className="num meta">{formatDate(p.paidOn)}</span><span>{p.text}</span><span className="num">{euro(p.amountCents)}</span>
            <button className="btn btn-ghost" aria-label={`${p.text} löschen`} onClick={() => void remove(p.id)}>Löschen</button>
          </li>
        ))}
      </ul>
      <form className="form" style={{ marginTop: 'var(--s-5)' }} noValidate onSubmit={(e) => void declare(e)} aria-label="Erklärung zur anderweitigen Nutzung">
        <p className="muted" style={{ margin: 0 }}>Erklärung der Person: wie viel der Pauschale {year} sie schon anderswo bekommt.</p>
        <div className="form-row">
          <MoneyField label="Anderswo genutzt" name="otherCents" defaultCents={row.otherCents} />
          <Field label="Erklärt am" name="declaredOn" type="date" defaultValue={todayLocal()} />
        </div>
        <div className="actions-row"><button className="btn">Erklärung speichern</button>{saved && <span className="meta" role="status">Gespeichert.</span>}</div>
      </form>
    </Sheet>
  );
}
