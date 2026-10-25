import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { api, ApiError } from '../lib/api.ts';
import { euroInput, parseEuro } from '../lib/money.ts';
import { useTitle } from '../lib/useTitle.ts';
import { LedgerLayout } from './Ledger.tsx';

interface Row { accountId: string; number: string; name: string; kind: 'income' | 'expense'; plannedCents: number | null; actualCents: number }
const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/** Budget per income/expense account and year against the books, with the variance. */
export function Budget({ me }: { me: Me }) {
  useTitle('Haushaltsplan');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const thisYear = new Date().getFullYear();
  const year = Number(params.get('jahr') ?? thisYear);
  const data = useQuery({ queryKey: ['budget', year], queryFn: () => api<Row[]>(`/ledger/budget?year=${year}`) });
  // Edited plan values as typed text, per account; saved together.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [state, setState] = useState<string>();
  const canWrite = me.permissions.ledger === 'write';
  const planned = (r: Row) => (r.accountId in draft ? parseEuro(draft[r.accountId]!) : r.plannedCents);

  async function save() {
    setState(undefined);
    try {
      const lines = Object.entries(draft).map(([accountId, v]) => ({ accountId, plannedCents: v.trim() === '' ? null : parseEuro(v) ?? NaN }));
      if (!lines.length) return;
      qc.setQueryData(['budget', year], await api<Row[]>('/ledger/budget', { method: 'PUT', body: { year, lines } }));
      setDraft({});
      setState('Gespeichert.');
    } catch (err) {
      setState(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    }
  }
  async function fromLastYear() {
    const last = await api<Row[]>(`/ledger/budget?year=${year - 1}`);
    setDraft(Object.fromEntries(last.filter((r) => r.actualCents > 0).map((r) => [r.accountId, euroInput(r.actualCents)])));
    setState(`Ist ${year - 1} als Plan eingesetzt. Prüfen und speichern.`);
  }

  const section = (kind: Row['kind'], title: string) => {
    const rows = (data.data ?? []).filter((r) => r.kind === kind);
    const sumPlan = rows.reduce((s, r) => s + (planned(r) ?? 0), 0);
    const sumIst = rows.reduce((s, r) => s + r.actualCents, 0);
    return (
      <table className="table budget" aria-label={title}>
        {/* Same columns in both tables, so income and expenses line up. */}
        <colgroup><col /><col className="c-plan" /><col className="c-ist" /><col className="c-diff hide-sm" /><col className="c-bar hide-sm" /></colgroup>
        <thead><tr><th scope="col">{title}</th><th scope="col" className="num">Plan</th><th scope="col" className="num">Ist</th><th scope="col" className="num hide-sm">Abweichung</th><th scope="col" className="hide-sm"><span className="sr-only">Stand</span></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const p = planned(r);
            // Spending more or earning less than planned is the side to watch.
            const diff = p === null ? null : r.actualCents - p;
            const bad = diff !== null && (kind === 'expense' ? diff > 0 : diff < 0);
            const share = p ? Math.min(100, Math.round((r.actualCents / p) * 100)) : 0;
            return (
              <tr key={r.accountId}>
                <td><span className="meta num">{r.number}</span> {r.name}</td>
                <td className="num">{canWrite ? <input className="input num" style={{ width: '100%' }} inputMode="decimal" aria-label={`Plan ${r.name}`} value={draft[r.accountId] ?? (r.plannedCents === null ? '' : euroInput(r.plannedCents))} onChange={(e) => setDraft({ ...draft, [r.accountId]: e.target.value })} /> : p === null ? '–' : euro(p)}</td>
                <td className="num">{euro(r.actualCents)}</td>
                <td className="num hide-sm" data-over={bad || undefined}>{diff === null ? '–' : `${diff > 0 ? '+' : ''}${euro(diff)}`}</td>
                <td className="hide-sm">{p ? <span className="budget-line" data-over={bad || undefined} aria-hidden><span style={{ width: `${share}%` }} /></span> : null}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><th scope="row">Summe</th><td className="num">{euro(sumPlan)}</td><td className="num">{euro(sumIst)}</td><td className="num hide-sm">{`${sumIst - sumPlan > 0 ? '+' : ''}${euro(sumIst - sumPlan)}`}</td><td className="hide-sm" /></tr></tfoot>
      </table>
    );
  };

  return (
    <LedgerLayout me={me}>
      <p className="muted" style={{ maxWidth: '72ch', marginBottom: 'var(--s-4)' }}>Planwerte je Einnahmen- und Ausgabenkonto (netto) und was bisher gebucht ist. Für den Haushaltsplan, den die Mitgliederversammlung beschließt.</p>
      <div className="toolbar">
        <select className="select" aria-label="Jahr" value={year} onChange={(e) => { setDraft({}); setParams({ jahr: e.target.value }, { replace: true }); }}>
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {canWrite && <button className="btn" onClick={() => void fromLastYear()}>Ist {year - 1} als Plan übernehmen</button>}
        {canWrite && <button className="btn btn-primary" disabled={!Object.keys(draft).length} onClick={() => void save()}>Plan speichern</button>}
        {state && <span className="meta" role="status">{state}</span>}
      </div>
      {data.data && (
        <div className="table-wrap budget-wrap">
          {section('income', 'Einnahmen')}
          {section('expense', 'Ausgaben')}
        </div>
      )}
    </LedgerLayout>
  );
}
