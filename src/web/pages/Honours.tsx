import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { PageHead } from '../components/PageHead.tsx';
import { ReportsNav } from './Census.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

interface Honour { memberId: string; name: string; date: string; years: number }
interface Honours { anniversaries: Honour[]; birthdays: Honour[] | null }

const day = (d: string) => d.slice(5).split('-').reverse().join('.') + '.';

/** Membership anniversaries and round birthdays of a year: for the AGM honours and greeting mails. */
export function HonoursPage({ me }: { me: Me }) {
  useTitle('Ehrungen');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const thisYear = new Date().getFullYear();
  const year = Number(params.get('jahr') ?? thisYear);
  const data = useQuery({ queryKey: ['honours', year], queryFn: () => api<Honours>(`/reports/honours?year=${year}`), retry: false });
  const canMail = me.permissions.communication === 'write';

  const list = (title: string, unit: string, items: Honour[]) => (
    <section className="section" aria-labelledby={`h-${unit}`}>
      <div className="section-head">
        <h2 id={`h-${unit}`}>{title}</h2>
        {canMail && items.length > 0 && <button className="btn" onClick={() => navigate('/kommunikation', { state: { memberIds: items.map((i) => i.memberId) } })}>E-Mail an alle {items.length}</button>}
      </div>
      {items.length === 0 ? <p className="muted">Niemand in {year}.</p> : (
        <ul className="timeline" aria-label={title}>
          {items.map((h) => (
            <li key={h.memberId} style={{ gridTemplateColumns: '5rem 1fr auto' }}>
              <span className="num meta">{day(h.date)}</span>
              <Link to={`/mitglieder/${h.memberId}`}>{h.name}</Link>
              <span className="num">{h.years} {unit}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="page">
      <PageHead title="Ehrungen" intro={`Vereinsjubiläen und runde Geburtstage ${year}, für die Ehrungen in der Mitgliederversammlung und Glückwünsche.`} />
      <ReportsNav />
      <div className="toolbar">
        <select className="select" aria-label="Jahr" value={year} onChange={(e) => setParams({ jahr: e.target.value }, { replace: true })}>
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {data.error && <div className="alert alert-error" role="alert">{data.error instanceof ApiError ? data.error.problem.title : 'Nicht verfügbar.'}</div>}
      {data.data && (
        <>
          {list('Vereinsjubiläen', 'Jahre Mitglied', data.data.anniversaries)}
          {data.data.birthdays ? list('Runde Geburtstage', 'Jahre', data.data.birthdays) : <p className="meta">Geburtstage siehst Du nur mit dem Recht auf Geburtsdaten.</p>}
        </>
      )}
    </div>
  );
}
