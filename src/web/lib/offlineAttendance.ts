import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/**
 * Attendance taken in a hall without signal: marks wait in this browser until the connection is back. Setting a
 * status is idempotent, so sending a mark twice does no harm. A mark the server refuses stays with its reason until
 * someone discards it, so nothing is lost silently.
 */
export interface PendingMark { path: string; eventId: string; date: string; memberId: string; name: string; status: 'attended' | 'not_attended'; error?: string }

const KEY = 'ov-attendance-queue';
const listeners = new Set<() => void>();
let cache: PendingMark[] | null = null;

function read(): PendingMark[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '[]') as PendingMark[];
  } catch {
    cache = [];
  }
  return cache;
}
function write(marks: PendingMark[]) {
  cache = marks;
  try {
    localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    // Private mode or full storage: the marks still live in memory until the page closes.
  }
  listeners.forEach((l) => l());
}

export const pathOf = (eventId: string, date: string, memberId: string) => `/events/${eventId}/occurrences/${date}/participants/${memberId}`;

/** The latest mark per member wins. */
export function enqueueMark(m: Omit<PendingMark, 'path' | 'error'>) {
  const path = pathOf(m.eventId, m.date, m.memberId);
  write([...read().filter((x) => x.path !== path), { ...m, path }]);
}
export const discardMark = (path: string) => write(read().filter((x) => x.path !== path));

export function usePendingMarks(eventId?: string | null, date?: string | null) {
  const all = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), read);
  return all.filter((m) => m.eventId === eventId && m.date === date);
}

let flushing: Promise<number> | null = null;
/** Sends waiting marks in order; stops at the first network failure. Returns how many arrived. */
export function flushMarks() {
  return (flushing ??= (async () => {
    let sent = 0;
    try {
      for (const m of read().filter((x) => !x.error)) {
        try {
          await api(m.path, { method: 'PUT', body: { status: m.status } });
          write(read().filter((x) => !(x.path === m.path && x.status === m.status)));
          sent++;
        } catch (e) {
          if (e instanceof ApiError && e.problem.type !== 'network') write(read().map((x) => (x.path === m.path ? { ...x, error: e.problem.title } : x)));
          else break;
        }
      }
    } finally {
      flushing = null;
    }
    return sent;
  })());
}

/** Mounted once in the app shell: sends waiting marks when the browser is back online, and every 30 seconds. */
export function useAttendanceSync() {
  const qc = useQueryClient();
  useEffect(() => {
    const run = () => {
      if (!read().some((m) => !m.error)) return;
      void flushMarks().then((n) => {
        if (n > 0) void qc.invalidateQueries({ queryKey: ['occurrence'] });
      });
    };
    run();
    window.addEventListener('online', run);
    const timer = setInterval(run, 30_000);
    return () => {
      window.removeEventListener('online', run);
      clearInterval(timer);
    };
  }, [qc]);
}
