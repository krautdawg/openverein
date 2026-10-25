import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { PageHead } from '../components/PageHead.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

type Gender = 'female' | 'male' | 'diverse' | 'unknown';
interface Row { groupId: string | null; name: string; counts: Record<string, Record<Gender, number>>; noBirthDate: number; total: number }
interface Census { year: number; date: string; brackets: string[]; rows: Row[] }

const SHORT: Record<Gender, string> = { female: 'w', male: 'm', diverse: 'd', unknown: 'o.A.' };

/** Annual census for the sports federation (LSB/DOSB): members on 1 January by age bracket and gender. */
export function Census() {
  useTitle('Bestandserhebung');
  const [params, setParams] = useSearchParams();
  const thisYear = new Date().getFullYear();
  const year = Number(params.get('jahr') ?? thisYear);
  const census = useQuery({ queryKey: ['census', year], queryFn: () => api<Census>(`/reports/census?year=${year}`), retry: false });

  return (
    <div className="page">
      <PageHead
        title="Bestandserhebung"
        intro={`Mitglieder am 1. Januar ${year} nach Altersgruppe und Geschlecht, für die Meldung an Landessportbund und Fachverbände. Das Alter ist ${year} minus Geburtsjahr.`}
        actions={<a className="btn" href={`/api/v1/reports/census.csv?year=${year}`} download><Download size={16} aria-hidden /> CSV</a>}
      />
      <div className="toolbar">
        <select className="select" aria-label="Jahr" value={year} onChange={(e) => setParams({ jahr: e.target.value }, { replace: true })}>
          {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>Stichtag 1.1.{y}</option>)}
        </select>
      </div>
      {census.error && <div className="alert alert-error" role="alert">{census.error instanceof ApiError ? [census.error.problem.title, census.error.problem.detail].filter(Boolean).join(' ') : 'Nicht verfügbar.'}</div>}
      {census.data && (
        <div className="table-wrap">
          <table className="table census" aria-label={`Bestandserhebung ${year}`}>
            <thead>
              <tr>
                <th scope="col">Bereich</th>
                {census.data.brackets.map((b) => <th key={b} scope="col" className="num">{b}</th>)}
                <th scope="col" className="num"><abbr title="ohne Geburtsdatum">o. Geb.</abbr></th>
                <th scope="col" className="num">gesamt</th>
              </tr>
            </thead>
            <tbody>
              {census.data.rows.map((r) => (
                <tr key={r.groupId ?? 'all'} data-total={r.groupId === null || undefined}>
                  <th scope="row">{r.name}</th>
                  {census.data.brackets.map((b) => {
                    const c = r.counts[b]!;
                    const sum = c.female + c.male + c.diverse + c.unknown;
                    return (
                      <td key={b} className="num">
                        {sum}
                        {sum > 0 && <span className="meta census-split">{(Object.keys(SHORT) as Gender[]).filter((g) => c[g]).map((g) => `${c[g]} ${SHORT[g]}`).join(' · ')}</span>}
                      </td>
                    );
                  })}
                  <td className="num">{r.noBirthDate}</td>
                  <td className="num"><strong>{r.total}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {census.data && census.data.rows[0]!.noBirthDate > 0 && <p className="meta" style={{ marginTop: 'var(--s-3)' }}>Für Mitglieder ohne Geburtsdatum fehlt die Altersgruppe. Trag es im Mitglied nach, sonst zählen sie in der Meldung nicht richtig.</p>}
    </div>
  );
}
