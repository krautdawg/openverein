import { ArrowDown, ArrowUp, Check } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OVERVIEW_SECTIONS, type Me, type OverviewSection } from '../../shared/auth.ts';
import { ChangeInbox } from '../components/ChangeInbox.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { api } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';
import type { Task } from '../../shared/tasks.ts';
import { TaskRow } from './Tasks.tsx';

interface OverviewData {
  members: { active: number; future: number; applicants: number; resigned: number; joinedThisYear: number; leftThisYear: number } | null;
  groups: number | null;
  onlineApplications: number | null;
  setup: { clubDetails: boolean; users: number };
}

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? 'Guten Morgen' : h < 18 ? 'Hallo' : 'Guten Abend';
}

export function Overview({ me }: { me: Me }) {
  useTitle('Übersicht');
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => api<OverviewData>('/overview') });
  const m = data?.members;
  const [arranging, setArranging] = useState(false);
  // Checklist items tick themselves off from real data; modules add their items as they ship.
  const steps = [
    { label: 'Anschrift und E-Mail des Vereins eintragen', done: !!data?.setup.clubDetails, to: '/einstellungen' },
    { label: 'Gruppen und Abteilungen anlegen', done: (data?.groups ?? 0) > 0, to: '/gruppen' },
    { label: 'Erste Mitglieder erfassen', done: !!m && m.active + m.future + m.resigned > 0, to: '/mitglieder?neu=1' },
    { label: 'Weitere Zugänge für den Vorstand einrichten', done: (data?.setup.users ?? 0) > 1, to: '/einstellungen/zugaenge' },
  ].filter((s) => s.to !== '/einstellungen/zugaenge' || me.permissions.settings === 'write');

  const sections: Record<OverviewSection, React.ReactNode> = {
    figures: m && (
        <section aria-label="Mitglieder in Zahlen">
          <dl className="figures">
            {[
              { label: 'aktive Mitglieder', n: m.active, to: '/mitglieder?ansicht=active' },
              ...(data?.onlineApplications ? [{ label: 'neue Online-Anträge', n: data.onlineApplications, to: '/antraege' }] : []),
              ...(m.applicants > 0 ? [{ label: 'offene Anträge', n: m.applicants, to: '/mitglieder?ansicht=applicant' }] : []),
              { label: 'gekündigt, noch Mitglied', n: m.resigned, to: '/mitglieder?ansicht=resigned' },
              { label: `Eintritte ${new Date().getFullYear()}`, n: m.joinedThisYear },
              { label: `Austritte ${new Date().getFullYear()}`, n: m.leftThisYear },
            ].map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.to ? <Link to={f.to}>{f.n}</Link> : f.n}</dd>
              </div>
            ))}
          </dl>
        </section>
    ),
    changes: me.permissions.members !== 'none' && <ChangeInbox canWrite={me.permissions.members === 'write'} />,
    tasks: <MyTasks meId={me.id} />,
    steps: (
      <section className="section" aria-labelledby="first-steps">
        <h2 id="first-steps">Erste Schritte</h2>
        <ul className="checklist">
          {steps.map((s) => (
            <li key={s.label} data-done={s.done}>
              <span className="tick" aria-hidden>{s.done && <Check size={12} strokeWidth={3} />}</span>
              <span className="label">{s.label}<span className="sr-only">{s.done ? ' (erledigt)' : ' (offen)'}</span></span>
              {!s.done && <Link to={s.to}>Erledigen</Link>}
            </li>
          ))}
        </ul>
      </section>
    ),
  };
  const order = arrange(me.overviewLayout);

  return (
    <div className="page">
      <PageHead title={`${greeting()}, ${me.name.split(' ')[0]}.`} intro={`Hier siehst Du, was im ${me.organization.name} gerade ansteht.`} actions={<button className="btn btn-ghost" aria-expanded={arranging} onClick={() => setArranging(!arranging)}>Übersicht anpassen</button>} />
      {arranging && <ArrangeOverview layout={me.overviewLayout} onDone={() => setArranging(false)} />}
      {order.filter((k) => !me.overviewLayout.hidden.includes(k)).map((k) => <Fragment key={k}>{sections[k]}</Fragment>)}
    </div>
  );
}

/** The saved order, with sections not yet in it (new ones) at their default place at the end. */
function arrange(layout: { order: string[] }): OverviewSection[] {
  const all = Object.keys(OVERVIEW_SECTIONS) as OverviewSection[];
  return [...layout.order.filter((k): k is OverviewSection => all.includes(k as OverviewSection)), ...all.filter((k) => !layout.order.includes(k))];
}

/** Show, hide and move the overview's sections; saved per access right away. */
function ArrangeOverview({ layout, onDone }: { layout: { order: string[]; hidden: string[] }; onDone: () => void }) {
  const qc = useQueryClient();
  const order = arrange(layout);
  async function save(next: { order: string[]; hidden: string[] }) {
    qc.setQueryData(['me'], await api<Me>('/auth/me/overview', { method: 'PUT', body: next }));
  }
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    void save({ order: next, hidden: layout.hidden });
  };
  return (
    <section className="section" aria-labelledby="arrange" style={{ marginBottom: 'var(--s-7)' }}>
      <h2 id="arrange">Übersicht anpassen</h2>
      <ol className="arrange-list">
        {order.map((k, i) => (
          <li key={k}>
            <label className="check"><input type="checkbox" checked={!layout.hidden.includes(k)} onChange={(e) => void save({ order, hidden: e.target.checked ? layout.hidden.filter((h) => h !== k) : [...layout.hidden, k] })} /> {OVERVIEW_SECTIONS[k]}</label>
            <span className="actions-inline">
              <button className="btn btn-ghost" aria-label={`${OVERVIEW_SECTIONS[k]} nach oben`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} aria-hidden /></button>
              <button className="btn btn-ghost" aria-label={`${OVERVIEW_SECTIONS[k]} nach unten`} disabled={i === order.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} aria-hidden /></button>
            </span>
          </li>
        ))}
      </ol>
      <div className="actions-row"><button className="btn" onClick={onDone}>Fertig</button></div>
    </section>
  );
}

/** Open tasks assigned to me, soonest first; hidden when there are none. */
function MyTasks({ meId }: { meId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['tasks', 'mine'], queryFn: () => api<Task[]>('/tasks?filter=mine') });
  if (!data?.length) return null;
  return (
    <section className="section" aria-labelledby="my-tasks">
      <h2 id="my-tasks">Deine Aufgaben</h2>
      <ul className="task-list" aria-label="Deine Aufgaben">
        {data.slice(0, 5).map((t) => <TaskRow key={t.id} t={t} meId={meId} onChange={() => qc.invalidateQueries({ queryKey: ['tasks'] })} />)}
      </ul>
      <p className="meta" style={{ marginTop: 'var(--s-2)' }}><Link to="/aufgaben">{data.length > 5 ? `Alle ${data.length} Aufgaben` : 'Zu den Aufgaben'}</Link></p>
    </section>
  );
}
