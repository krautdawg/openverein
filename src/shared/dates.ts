/** Calendar dates as `YYYY-MM-DD` strings. Legal dates never pass through a time zone. */

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Today's date in the club's business time zone (not the server's). */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const parse = (s: string) => new Date(`${s}T00:00:00Z`);

export function addDays(date: string, days: number) {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** Last day of the period (month, quarter, half year, year) that contains `date`. */
export function periodEnd(date: string, months: 1 | 3 | 6 | 12): string {
  const d = parse(date);
  const m = d.getUTCMonth();
  const endMonth = Math.floor(m / months) * months + months; // exclusive
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), endMonth, 0)));
}

export type ExitAt = 'any_day' | 'month_end' | 'quarter_end' | 'half_year_end' | 'year_end';

/** Earliest exit date allowed by the notice rule: notice date + notice weeks, rounded up to the period end. */
export function proposeExitDate(noticeDate: string, noticeWeeks: number, exitAt: ExitAt): string {
  const earliest = addDays(noticeDate, noticeWeeks * 7);
  switch (exitAt) {
    case 'any_day': return earliest;
    case 'month_end': return periodEnd(earliest, 1);
    case 'quarter_end': return periodEnd(earliest, 3);
    case 'half_year_end': return periodEnd(earliest, 6);
    case 'year_end': return periodEnd(earliest, 12);
  }
}

export function formatDate(date: string | null | undefined) {
  if (!date) return '';
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

/** First day of the month `n` months after the month of `date`. */
export function addMonths(date: string, n: number): string {
  const d = parse(date);
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
}

/** Same day-of-month `n` months later, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonthsKeepDay(date: string, n: number): string {
  const d = parse(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return isoDate(target);
}

/** Whole calendar months from the month of `a` to the month of `b` (0 when same month). */
export const monthDiff = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

/** Calendar months touched by the inclusive range [a, b]. */
export const monthsTouched = (a: string, b: string) => monthDiff(a, b) + 1;

export const minDate = (a: string, b: string) => (a < b ? a : b);
export const maxDate = (a: string, b: string) => (a > b ? a : b);
