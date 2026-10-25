import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { Field } from '../components/Field.tsx';
import { MoneyField } from '../components/MoneyField.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';
import { ReportsNav } from './Census.tsx';

interface Rule { required: number | null; rateCents: number | null; ageFrom: number | null; ageTo: number | null }
interface Row { memberId: string; name: string; required: number; done: number; missing: number; feeCents: number; invoiceId: string | null }
interface Entry { id: string; workedOn: string; hours: number; text: string }

const hours = (h: number) => h.toLocaleString('de-DE', { maximumFractionDigits: 2 });
const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const problemText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');

/** Work hours: the club rule, hours per member and year, and the substitute fee for missing hours. */
export function WorkHours({ me }: { me: Me }) {
  useTitle('Arbeitsstunden');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const thisYear = new Date().getFullYear();
  const year = Number(params.get('jahr') ?? thisYear);
  const data = useQuery({ queryKey: ['work-hours', year], queryFn: () => api<{ settings: Rule; members: Row[] }>(`/work-hours?year=${year}`) });
  const [logging, setLogging] = useState<Row | null>(null);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const canLog = me.permissions.members === 'write';
  const canSettle = me.permissions.invoices === 'write';
  const rule = data.data?.settings;
  const open = data.data?.members.filter((m) => m.missing > 0 && !m.invoiceId) ?? [];

  async function settle() {
    setError(undefined);
    try {
      const r = await api<{ drafted: number }>('/work-hours/settle', { method: 'POST', body: { year } });
      setResult(`${r.drafted} Rechnungsentwürfe angelegt. Prüfe und stelle sie unter Rechnungen aus.`);
      await qc.invalidateQueries({ queryKey: ['work-hours'] });
    } catch (err) {
      setError(problemText(err));
    }
  }

  return (
    <div className="page">
      <PageHead title="Arbeitsstunden" intro="Wer wie viele Stunden für den Verein geleistet hat, und das Ersatzgeld für fehlende Stunden." />
      <ReportsNav />
      {me.permissions.settings === 'write' && rule && <RuleForm rule={rule} />}
      {rule && rule.required === null && <p className="muted">Noch keine Regel: Trag oben ein, wie viele Stunden pro Jahr anfallen.</p>}
      <div className="toolbar">
        <select className="select" aria-label="Jahr" value={year} onChange={(e) => setParams({ jahr: e.target.value }, { replace: true })}>
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {canSettle && open.length > 0 && <button className="btn" onClick={() => void settle()}>Ersatzgeld abrechnen ({open.length})</button>}
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {result && <div className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-3)' }}>{result}</div>}
      {data.data && (
        <div className="table-wrap">
          <table className="table" aria-label={`Arbeitsstunden ${year}`}>
            <thead><tr><th scope="col">Name</th><th scope="col" className="num">Soll</th><th scope="col" className="num">Geleistet</th><th scope="col" className="num">Offen</th><th scope="col" className="num hide-sm">Ersatzgeld</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
            <tbody>
              {data.data.members.map((m) => (
                <tr key={m.memberId}>
                  <td><Link to={`/mitglieder/${m.memberId}`}>{m.name}</Link></td>
                  <td className="num">{m.required ? hours(m.required) : <span className="meta">befreit</span>}</td>
                  <td className="num">{hours(m.done)}</td>
                  <td className="num">{m.missing ? hours(m.missing) : '–'}</td>
                  <td className="num hide-sm">{m.invoiceId ? <Link to={`/rechnungen/${m.invoiceId}`}>{euro(m.feeCents)}</Link> : m.feeCents ? euro(m.feeCents) : '–'}</td>
                  <td>{canLog && <button className="btn btn-ghost" aria-label={`Stunden für ${m.name}`} onClick={() => setLogging(m)}>Stunden …</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {logging && <LogSheet row={logging} year={year} onClose={() => setLogging(null)} />}
    </div>
  );
}

function RuleForm({ rule }: { rule: Rule }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k: string) => (String(f.get(k) ?? '').trim() === '' ? null : Number(String(f.get(k)).replace(',', '.')));
    setError(undefined);
    setSaved(false);
    try {
      await api('/work-hours/settings', { method: 'PUT', body: { required: n('required'), rateCents: n('rateCents'), ageFrom: n('ageFrom'), ageTo: n('ageTo') } });
      await qc.invalidateQueries({ queryKey: ['work-hours'] });
      setSaved(true);
    } catch (err) {
      setError(problemText(err));
    }
  }
  return (
    <form className="age-rule" style={{ marginBottom: 'var(--s-5)' }} onSubmit={(e) => void save(e)} aria-label="Regel für Arbeitsstunden">
      <span>Pro Jahr</span>
      <input name="required" className="input" style={{ width: 72 }} inputMode="decimal" aria-label="Stunden pro Jahr" defaultValue={rule.required ?? ''} />
      <span>Stunden, Ersatzgeld je fehlender Stunde</span>
      <div style={{ width: 120 }}><MoneyField label="Ersatzgeld" name="rateCents" defaultCents={rule.rateCents ?? undefined} /></div>
      <span>für Mitglieder von</span>
      <input name="ageFrom" className="input" style={{ width: 64 }} inputMode="numeric" aria-label="Alter von" defaultValue={rule.ageFrom ?? ''} />
      <span>bis</span>
      <input name="ageTo" className="input" style={{ width: 64 }} inputMode="numeric" aria-label="Alter bis" defaultValue={rule.ageTo ?? ''} />
      <span>Jahren.</span>
      <button className="btn">Speichern</button>
      {saved && <span className="meta" role="status">Gespeichert.</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </form>
  );
}

function LogSheet({ row, year, onClose }: { row: Row; year: number; onClose: () => void }) {
  const qc = useQueryClient();
  const entries = useQuery({ queryKey: ['work-hour-entries', row.memberId, year], queryFn: () => api<Entry[]>(`/work-hours/entries?memberId=${row.memberId}&year=${year}`) });
  const [error, setError] = useState<ApiError>();
  const [formKey, setFormKey] = useState(0);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/work-hours/entries', { method: 'POST', body: { memberId: row.memberId, workedOn: f.get('workedOn'), hours: Number(String(f.get('hours')).replace(',', '.')), text: f.get('text') } });
      await qc.invalidateQueries({ queryKey: ['work-hours'] });
      await qc.invalidateQueries({ queryKey: ['work-hour-entries'] });
      setFormKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  async function remove(id: string) {
    await api(`/work-hours/entries/${id}`, { method: 'DELETE' }).catch((err: unknown) => setError(err instanceof ApiError ? err : undefined));
    await qc.invalidateQueries({ queryKey: ['work-hours'] });
    await qc.invalidateQueries({ queryKey: ['work-hour-entries'] });
  }
  return (
    <Sheet title={`Arbeitsstunden ${year}: ${row.name}`} open onClose={onClose}>
      <form key={formKey} className="form" noValidate onSubmit={(e) => void add(e)} aria-label="Stunden eintragen">
        {error && <div className="alert alert-error" role="alert">{problemText(error)}</div>}
        <div className="form-row">
          <Field label="Datum" name="workedOn" type="date" defaultValue={todayLocal()} error={error?.fieldError('workedOn')} />
          <Field label="Stunden" name="hours" inputMode="decimal" placeholder="z. B. 2,5" error={error?.fieldError('hours')} />
        </div>
        <Field label="Wofür" name="text" placeholder="z. B. Platzpflege" error={error?.fieldError('text')} />
        <div className="actions-row"><button className="btn btn-primary">Eintragen</button></div>
      </form>
      <ul className="timeline" aria-label="Eingetragene Stunden" style={{ marginTop: 'var(--s-5)' }}>
        {entries.data?.length === 0 && <li style={{ gridTemplateColumns: '1fr' }}><span className="muted">Noch keine Stunden in {year}.</span></li>}
        {entries.data?.map((x) => (
          <li key={x.id} style={{ gridTemplateColumns: '6rem 1fr auto auto' }}>
            <span className="num meta">{formatDate(x.workedOn)}</span>
            <span>{x.text}</span>
            <span className="num">{hours(x.hours)} Std.</span>
            <button className="btn btn-ghost" aria-label={`${x.text} löschen`} onClick={() => void remove(x.id)}>Löschen</button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
