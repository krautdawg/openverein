import { Check } from 'lucide-react';
import { Link } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { PageHead } from '../components/PageHead.tsx';
import { useTitle } from '../lib/useTitle.ts';

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? 'Guten Morgen' : h < 18 ? 'Hallo' : 'Guten Abend';
}

export function Overview({ me }: { me: Me }) {
  useTitle('Übersicht');
  // Checklist items tick themselves off from real data; modules add their items as they ship.
  const steps = [
    { label: 'Verein angelegt', done: true, to: '/einstellungen' },
    { label: 'Stammdaten des Vereins prüfen', done: false, to: '/einstellungen' },
  ];
  return (
    <div className="page">
      <PageHead title={`${greeting()}, ${me.name.split(' ')[0]}.`} intro={`Hier siehst Du, was im ${me.organization.name} gerade ansteht.`} />
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
