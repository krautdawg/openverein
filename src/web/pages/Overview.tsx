import { Check } from 'lucide-react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '../../shared/auth.ts';
import { ChangeInbox } from '../components/ChangeInbox.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { api } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

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
  // Checklist items tick themselves off from real data; modules add their items as they ship.
  const steps = [
    { label: 'Anschrift und E-Mail des Vereins eintragen', done: !!data?.setup.clubDetails, to: '/einstellungen' },
    { label: 'Gruppen und Abteilungen anlegen', done: (data?.groups ?? 0) > 0, to: '/gruppen' },
    { label: 'Erste Mitglieder erfassen', done: !!m && m.active + m.future + m.resigned > 0, to: '/mitglieder?neu=1' },
    { label: 'Weitere Zugänge für den Vorstand einrichten', done: (data?.setup.users ?? 0) > 1, to: '/einstellungen/zugaenge' },
  ].filter((s) => s.to !== '/einstellungen/zugaenge' || me.permissions.settings === 'write');

  return (
    <div className="page">
      <PageHead title={`${greeting()}, ${me.name.split(' ')[0]}.`} intro={`Hier siehst Du, was im ${me.organization.name} gerade ansteht.`} />
      {m && (
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
      )}
      {me.permissions.members !== 'none' && <ChangeInbox canWrite={me.permissions.members === 'write'} />}
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
    </div>
  );
}
