import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { Field } from '../components/Field.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { ReportsNav } from './Census.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

interface Honour { memberId: string; name: string; date: string; years: number }
interface Awarded { id: string; memberId: string; name: string; title: string; awardedOn: string; decision: string | null }
interface Honours { anniversaries: Honour[]; birthdays: Honour[] | null; awarded: Awarded[] }

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
  const canWrite = me.permissions.members === 'write';
  const qc = useQueryClient();
  const [awarding, setAwarding] = useState<Honour | null>(null);
  const [error, setError] = useState<ApiError>();
  async function award(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!awarding) return;
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api(`/members/${awarding.memberId}/honours`, { method: 'POST', body: { title: f.get('title'), awardedOn: f.get('awardedOn'), decision: f.get('decision') || null } });
      setAwarding(null);
      await qc.invalidateQueries({ queryKey: ['honours'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  async function remove(a: Awarded) {
    await api(`/members/${a.memberId}/honours/${a.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['honours'] });
  }

  const list = (title: string, unit: string, items: Honour[], honour = false) => (
    <section className="section" aria-labelledby={`h-${unit}`}>
      <div className="section-head">
        <h2 id={`h-${unit}`}>{title}</h2>
        {canMail && items.length > 0 && <button className="btn" onClick={() => navigate('/kommunikation', { state: { memberIds: items.map((i) => i.memberId) } })}>E-Mail an alle {items.length}</button>}
      </div>
      {items.length === 0 ? <p className="muted">Niemand in {year}.</p> : (
        <ul className="timeline" aria-label={title}>
          {items.map((h) => (
            <li key={h.memberId} style={{ gridTemplateColumns: honour && canWrite ? '5rem 1fr auto auto' : '5rem 1fr auto' }}>
              <span className="num meta">{day(h.date)}</span>
              <Link to={`/mitglieder/${h.memberId}`}>{h.name}</Link>
              <span className="num">{h.years} {unit}</span>
              {honour && canWrite && <button className="linklike" onClick={() => setAwarding(h)}>Ehrung eintragen</button>}
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
          {list('Vereinsjubiläen', 'Jahre Mitglied', data.data.anniversaries, true)}
          {data.data.birthdays ? list('Runde Geburtstage', 'Jahre', data.data.birthdays) : <p className="meta">Geburtstage siehst Du nur mit dem Recht auf Geburtsdaten.</p>}
          <section className="section" aria-labelledby="h-awarded">
            <h2 id="h-awarded">Verliehen {year}</h2>
            {awarding && (
              <form key={awarding.memberId} className="inline-form" noValidate onSubmit={award} aria-label="Ehrung eintragen" style={{ maxWidth: 720, marginBottom: 'var(--s-4)' }}>
                <p style={{ margin: 0 }}><strong>{awarding.name}</strong> <span className="muted">· {awarding.years} Jahre</span></p>
                {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.title}</div>}
                <div className="form-row">
                  <Field label="Ehrung" name="title" defaultValue={`Ehrennadel ${awarding.years} Jahre`} error={error?.fieldError('title')} autoFocus />
                  <Field label="Verliehen am" name="awardedOn" type="date" defaultValue={awarding.date} error={error?.fieldError('awardedOn')} />
                </div>
                <Field label="Beschluss (optional)" name="decision" placeholder="z. B. Vorstandsbeschluss vom 12.03." />
                <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Eintragen</button><button type="button" className="btn btn-ghost" onClick={() => setAwarding(null)}>Abbrechen</button></div>
              </form>
            )}
            {data.data.awarded.length === 0 ? <p className="muted">Noch keine Ehrung für {year} eingetragen.</p> : (
              <ul className="timeline" aria-label={`Verliehen ${year}`}>
                {data.data.awarded.map((a) => (
                  <li key={a.id} style={{ gridTemplateColumns: '5rem 1fr auto' }}>
                    <span className="num meta">{day(a.awardedOn)}</span>
                    <span><Link to={`/mitglieder/${a.memberId}`}>{a.name}</Link>: {a.title}{a.decision && <span className="meta" style={{ display: 'block' }}>{a.decision}</span>}</span>
                    {canWrite ? <button className="linklike" onClick={() => void remove(a)}>entfernen</button> : <span />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
