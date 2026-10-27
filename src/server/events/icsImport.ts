import { createHash } from 'node:crypto';
import { formatRule, parseRule } from '../../shared/recurrence.ts';

/** One event from an ICS file, in the club's wall-clock time ('YYYY-MM-DD HH:MM:SS'), as the event table stores it. */
export interface ImportedEvent {
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  rrule: string | null;
  exdates: string[];
  /** set when the file asked for more than OpenVerein can show (e.g. a series rule it cannot repeat) */
  note: string | null;
}

interface Prop { name: string; params: Record<string, string>; value: string }

const unescape = (s: string) => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

function parseLine(line: string): Prop | null {
  // The value starts at the first colon outside a quoted parameter value.
  let quoted = false;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(';');
  const params = Object.fromEntries(rawParams.map((p) => { const [k, ...v] = p.split('='); return [k!.toUpperCase(), v.join('=').replace(/^"|"$/g, '')]; }));
  return { name: name!.toUpperCase(), params, value: line.slice(i + 1) };
}

/** Wall-clock time of an instant in a time zone. */
function inZone(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms)).replace(',', '').replace('T', ' ');
}
/** The instant of a wall-clock time in a time zone (two passes settle the offset around DST changes). */
function instantOf(wall: string, timeZone: string) {
  const asUtc = Date.parse(`${wall.replace(' ', 'T')}Z`);
  let ms = asUtc;
  for (let k = 0; k < 2; k++) ms = asUtc - (Date.parse(`${inZone(ms, timeZone).replace(' ', 'T')}Z`) - ms);
  return ms;
}

function parseDate(p: Prop, clubZone: string): { wall: string; allDay: boolean } | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  // The pattern alone lets 20261345 through: the date and time must exist (else the event is skipped, not a 500).
  const day = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(day) || new Date(day).toISOString().slice(0, 10) !== date || Number(m[4] ?? 0) > 23 || Number(m[5] ?? 0) > 59 || Number(m[6] ?? 0) > 59) return null;
  if (!m[4] || p.params.VALUE === 'DATE') return { wall: `${date} 00:00:00`, allDay: true };
  const wall = `${date} ${m[4]}:${m[5]}:${m[6]}`;
  if (m[7]) return { wall: inZone(Date.parse(`${wall.replace(' ', 'T')}Z`), clubZone), allDay: false };
  const tz = p.params.TZID;
  if (tz && tz !== clubZone) {
    try {
      return { wall: inZone(instantOf(wall, tz), clubZone), allDay: false };
    } catch {
      return { wall, allDay: false }; // unknown zone name: keep the written time
    }
  }
  return { wall, allDay: false };
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function durationMs(v: string) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, w, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return ((((w! * 7 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

/** Keeps a series rule only when OpenVerein can repeat it exactly; otherwise the first date is imported with a note. */
function supportedRule(v: string): string | null {
  const parts = Object.fromEntries(v.split(';').filter(Boolean).map((x) => x.split('=') as [string, string]));
  delete parts.WKST;
  if (Object.keys(parts).some((k) => !['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT'].includes(k))) return null;
  if (parts.BYDAY && (parts.FREQ !== 'WEEKLY' || /\d/.test(parts.BYDAY))) return null;
  if (parts.UNTIL) parts.UNTIL = parts.UNTIL.slice(0, 8);
  try {
    return formatRule(parseRule(Object.entries(parts).map(([k, x]) => `${k}=${x}`).join(';')));
  } catch {
    return null;
  }
}

/** Parses VEVENTs from an ICS file (RFC 5545 subset). Cancelled events and single changes to a series are skipped. */
export function parseIcs(text: string, clubZone: string): { events: ImportedEvent[]; skipped: { title: string; reason: string }[] } {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: ImportedEvent[] = [];
  const skipped: { title: string; reason: string }[] = [];
  let props: Prop[] | null = null;
  let depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { props = []; depth = 0; continue; }
    if (!props) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:') && depth > 0) { depth--; continue; }
    if (line === 'END:VEVENT') {
      const one = (n: string) => props!.find((p) => p.name === n);
      const title = unescape(one('SUMMARY')?.value ?? '').trim().slice(0, 200) || '(ohne Titel)';
      const start = one('DTSTART') && parseDate(one('DTSTART')!, clubZone);
      if (!start) skipped.push({ title, reason: 'ohne gültigen Beginn' });
      else if (one('STATUS')?.value.toUpperCase() === 'CANCELLED') skipped.push({ title, reason: 'abgesagt' });
      else if (one('RECURRENCE-ID')) skipped.push({ title, reason: 'Einzeländerung einer Serie' });
      // A given but unreadable end is not "no end" (that would make a zero-length event); both at once is invalid too.
      else if (one('DTEND') && one('DURATION')) skipped.push({ title, reason: 'Ende und Dauer zugleich angegeben' });
      else if (one('DTEND') && !parseDate(one('DTEND')!, clubZone)) skipped.push({ title, reason: 'ohne gültiges Ende' });
      else if (one('DURATION') && durationMs(one('DURATION')!.value) === null) skipped.push({ title, reason: 'ohne gültige Dauer' });
      else {
        const endProp = one('DTEND') && parseDate(one('DTEND')!, clubZone);
        const dur = one('DURATION') ? durationMs(one('DURATION')!.value) : null;
        let endsAt: string;
        if (start.allDay) {
          // DTEND of an all-day event is exclusive; one day without DTEND.
          const lastDay = endProp ? addDays(endProp.wall.slice(0, 10), -1) : start.wall.slice(0, 10);
          endsAt = `${lastDay < start.wall.slice(0, 10) ? start.wall.slice(0, 10) : lastDay} 23:59:00`;
        } else if (endProp) endsAt = endProp.wall < start.wall ? start.wall : endProp.wall;
        else if (dur !== null) endsAt = inZone(Date.parse(`${start.wall.replace(' ', 'T')}Z`) + dur, 'UTC');
        else endsAt = start.wall;
        const rawRule = one('RRULE')?.value ?? null;
        const rrule = rawRule ? supportedRule(rawRule) : null;
        const exdates = props.filter((p) => p.name === 'EXDATE').flatMap((p) => p.value.split(',').map((v) => parseDate({ ...p, value: v }, clubZone)?.wall.slice(0, 10)).filter((x): x is string => !!x));
        const uid = one('UID')?.value.trim() || createHash('sha256').update(`${start.wall}|${title}`).digest('hex').slice(0, 32);
        events.push({
          uid: uid.slice(0, 255), title,
          description: one('DESCRIPTION') ? unescape(one('DESCRIPTION')!.value).slice(0, 5000) : null,
          location: one('LOCATION') ? unescape(one('LOCATION')!.value).slice(0, 200) : null,
          startsAt: start.wall, endsAt, allDay: start.allDay, rrule, exdates,
          note: rawRule && !rrule ? 'Wiederholung nicht übernommen, nur der erste Termin' : null,
        });
      }
      props = null;
      continue;
    }
    if (depth === 0) {
      const p = parseLine(line);
      if (p) props.push(p);
    }
  }
  return { events, skipped };
}
