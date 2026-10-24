import { X } from 'lucide-react';
import { formatDate } from '../../shared/dates.ts';
import type { Membership } from '../../shared/members.ts';
import { courtVar } from '../lib/hooks.ts';

const day = (s: string) => Date.parse(`${s}T00:00:00Z`);

/**
 * A member's group history as court lines on one time axis: each spell is a line in the group's
 * colour from its start to its end; open spells run to today with an arrow.
 */
export function CourtLines({ memberships, today, onEnd }: { memberships: Membership[]; today: string; onEnd?: (m: Membership) => void }) {
  if (memberships.length === 0) return <p className="muted">Noch in keiner Gruppe.</p>;
  const start = Math.min(...memberships.map((m) => day(m.validFrom)));
  const end = Math.max(day(today), ...memberships.map((m) => (m.validTo ? day(m.validTo) : day(today))));
  const span = Math.max(end - start, 86_400_000);
  const pct = (t: number) => ((t - start) / span) * 100;

  return (
    <div className="court-lines">
      {memberships.map((m) => {
        const from = pct(day(m.validFrom));
        const to = pct(m.validTo ? day(m.validTo) : day(today));
        const open = !m.validTo || m.validTo >= today;
        return (
          <div className="court-row" key={m.id} style={courtVar(m.color)}>
            <div className="label">
              <span>{m.groupName}</span>
              <span className="dates">
                {formatDate(m.validFrom)} – {m.validTo ? formatDate(m.validTo) : 'heute'}
                {open && onEnd && (
                  <button className="icon-btn" style={{ width: 24, height: 24, marginLeft: 4, verticalAlign: 'middle' }} aria-label={`${m.groupName}: Zugehörigkeit beenden`} onClick={() => onEnd(m)}>
                    <X size={14} />
                  </button>
                )}
              </span>
            </div>
            <div className="track" aria-hidden>
              <div className="line" data-open={!m.validTo} style={{ left: `${from}%`, width: `${Math.max(to - from, 1)}%` }} />
            </div>
          </div>
        );
      })}
      <div className="axis" aria-hidden>
        <span>{formatDate(new Date(start).toISOString().slice(0, 10))}</span>
        <span>heute</span>
      </div>
    </div>
  );
}
