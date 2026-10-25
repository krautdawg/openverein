import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { formatDate } from '../../shared/dates.ts';
import { api } from '../lib/api.ts';

interface PublicCalendar { calendar: string; club: string; events: { title: string; date: string; startsAt: string; endsAt: string; allDay: boolean; location: string | null }[] }
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'UTC' });

/** Read-only list of a public calendar, made to be embedded in the club website (iframe). */
export function CalendarWidget() {
  const { id } = useParams();
  const data = useQuery({ queryKey: ['public-calendar', id], queryFn: () => api<PublicCalendar>(`/public/calendars/${id}/events`), retry: false });
  if (data.error) return <main className="widget"><p className="muted">Dieser Kalender ist nicht öffentlich.</p></main>;
  if (!data.data) return null;
  return (
    <main className="widget">
      <h1 className="widget-title">{data.data.calendar}</h1>
      {data.data.events.length === 0 ? <p className="muted">Keine Termine in den nächsten Wochen.</p> : (
        <ul className="widget-list" aria-label={`Termine ${data.data.calendar}`}>
          {data.data.events.map((e, i) => (
            <li key={`${e.date}-${i}`}>
              <span className="widget-date num">{weekday(e.date)} {formatDate(e.date)}</span>
              <span>
                <strong>{e.title}</strong>
                <span className="meta" style={{ display: 'block' }}>{e.allDay ? 'ganztägig' : `${e.startsAt.slice(11, 16)}–${e.endsAt.slice(11, 16)} Uhr`}{e.location ? ` · ${e.location}` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="meta widget-foot">{data.data.club}</p>
    </main>
  );
}
