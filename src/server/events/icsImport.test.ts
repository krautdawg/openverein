import { describe, expect, it } from 'vitest';
import { ics } from '../routes/events.ts';
import { parseIcs } from './icsImport.ts';

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe('parseIcs', () => {
  it('reads local, UTC and all-day times, unfolds and unescapes, keeps supported series', () => {
    const { events, skipped } = parseIcs(wrap([
      'BEGIN:VEVENT', 'UID:a1', 'DTSTART;TZID=Europe/Berlin:20261103T180000', 'DTEND;TZID=Europe/Berlin:20261103T193000', 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261222T235959Z;WKST=MO', 'EXDATE;TZID=Europe/Berlin:20261117T180000',
      'SUMMARY:Training\\, Halle 2', 'DESCRIPTION:Bitte\\nHallenschuhe', '  mitbringen', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b2', 'DTSTART:20260701T160000Z', 'DURATION:PT2H', 'SUMMARY:Sommerfest', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:c3', 'DTSTART;VALUE=DATE:20261231', 'DTEND;VALUE=DATE:20270102', 'SUMMARY:Silvesterturnier', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:d4', 'DTSTART:20261101T100000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1', 'SUMMARY:Monatstreffen', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:e5', 'DTSTART:20261101T100000', 'STATUS:CANCELLED', 'SUMMARY:Fällt aus', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:a1', 'RECURRENCE-ID;TZID=Europe/Berlin:20261110T180000', 'DTSTART;TZID=Europe/Berlin:20261110T190000', 'SUMMARY:Training später', 'END:VEVENT',
    ].join('\r\n')), 'Europe/Berlin');
    expect(events.map((e) => [e.uid, e.title, e.startsAt, e.endsAt, e.allDay, e.rrule])).toEqual([
      ['a1', 'Training, Halle 2', '2026-11-03 18:00:00', '2026-11-03 19:30:00', false, 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261222'],
      ['b2', 'Sommerfest', '2026-07-01 18:00:00', '2026-07-01 20:00:00', false, null],
      ['c3', 'Silvesterturnier', '2026-12-31 00:00:00', '2027-01-01 23:59:00', true, null],
      ['d4', 'Monatstreffen', '2026-11-01 10:00:00', '2026-11-01 10:00:00', false, null],
    ]);
    expect(events[0]!.description).toBe('Bitte\nHallenschuhe mitbringen');
    expect(events[0]!.exdates).toEqual(['2026-11-17']);
    expect(events[3]!.note).toContain('Wiederholung nicht übernommen');
    expect(skipped.map((s) => s.reason)).toEqual(['abgesagt', 'Einzeländerung einer Serie']);
  });

  it('converts another time zone into the club time and reads its own feed back', () => {
    const { events } = parseIcs(wrap('BEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=America/New_York:20260115T120000\r\nSUMMARY:Call\r\nEND:VEVENT'), 'Europe/Berlin');
    expect(events[0]!.startsAt).toBe('2026-01-15 18:00:00');
    const feed = ics('Verein', 'Europe/Berlin', [{ id: 'e1', title: 'Training', location: 'Halle', description: null, starts_at: '2026-11-03 18:00:00', ends_at: '2026-11-03 19:30:00', all_day: false, rrule: 'FREQ=WEEKLY;BYDAY=TU', exdates: [] }] as never);
    expect(parseIcs(feed, 'Europe/Berlin').events[0]).toMatchObject({ title: 'Training', location: 'Halle', startsAt: '2026-11-03 18:00:00', rrule: 'FREQ=WEEKLY;BYDAY=TU' });
  });

  it('skips an event whose date does not exist instead of failing the import', () => {
    const r = parseIcs(wrap('BEGIN:VEVENT\r\nUID:bad\r\nSUMMARY:Kaputt\r\nDTSTART:20261345T100000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:ok\r\nSUMMARY:Gut\r\nDTSTART:20261105T100000Z\r\nEND:VEVENT'), 'Europe/Berlin');
    expect(r.events.map((e) => e.title)).toEqual(['Gut']);
    expect(r.skipped).toHaveLength(1);
  });
});
