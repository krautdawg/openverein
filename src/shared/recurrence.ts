/**
 * The RRULE subset OpenVerein writes: FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY (weekly),
 * UNTIL=YYYYMMDD or COUNT. Occurrences are calendar dates in the club's local time; the event keeps
 * its wall-clock time, so training at 18:00 stays at 18:00 across daylight-saving changes.
 */
export interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byDay: string[];
  until: string | null;
  count: number | null;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseRule(rrule: string): Rule {
  const parts = Object.fromEntries(rrule.split(';').map((p) => p.split('=') as [string, string]));
  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') throw new Error(`unsupported FREQ ${freq}`);
  const interval = Number(parts.INTERVAL ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw new Error('INTERVAL must be 1–52');
  const byDay = parts.BYDAY ? parts.BYDAY.split(',') : [];
  if (byDay.some((d) => !DAYS.includes(d))) throw new Error('invalid BYDAY');
  const until = parts.UNTIL ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` : null;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > 1000)) throw new Error('COUNT must be 1–1000');
  return { freq, interval, byDay, until, count };
}

export function formatRule(r: Rule) {
  return [`FREQ=${r.freq}`, r.interval > 1 ? `INTERVAL=${r.interval}` : null, r.byDay.length ? `BYDAY=${r.byDay.join(',')}` : null, r.until ? `UNTIL=${r.until.replaceAll('-', '')}` : null, r.count ? `COUNT=${r.count}` : null]
    .filter(Boolean)
    .join(';');
}

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(d(s).getTime() + n * 86_400_000));

/** All occurrence dates of a series starting on `start`, within [from, to], minus exceptions. */
export function occurrences(start: string, rrule: string | null, from: string, to: string, exdates: string[] = []): string[] {
  if (!rrule) return start >= from && start <= to ? [start] : [];
  const r = parseRule(rrule);
  const out: string[] = [];
  const skip = new Set(exdates);
  let n = 0;
  const emit = (date: string) => {
    n++;
    if (date >= from && date <= to && !skip.has(date)) out.push(date);
  };
  const done = (date: string) => (r.until !== null && date > r.until) || (r.count !== null && n >= r.count) || date > to;
  if (r.freq === 'DAILY') {
    for (let date = start; !done(date); date = addDays(date, r.interval)) emit(date);
  } else if (r.freq === 'WEEKLY') {
    const days = r.byDay.length ? r.byDay.map((x) => DAYS.indexOf(x)).sort() : [d(start).getUTCDay()];
    // Weeks start on Monday; walk week by week from the start's week.
    const monday = addDays(start, -((d(start).getUTCDay() + 6) % 7));
    for (let week = monday; !done(week); week = addDays(week, 7 * r.interval)) {
      for (const wd of days) {
        const date = addDays(week, (wd + 6) % 7);
        if (date < start) continue;
        if (done(date)) break;
        emit(date);
      }
    }
  } else {
    const day = d(start).getUTCDate();
    for (let k = 0; ; k += r.interval) {
      const base = new Date(Date.UTC(d(start).getUTCFullYear(), d(start).getUTCMonth() + k, 1));
      const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
      if (day > last) continue; // no 31 February: that month is skipped, like RFC 5545
      const date = iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day)));
      if (done(date)) break;
      emit(date);
      if (k > 12 * 100) break;
    }
  }
  return out;
}
