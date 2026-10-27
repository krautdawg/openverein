import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/**
 * Attendance taken in a hall without signal: marks wait in this browser until the connection is back. Setting a
 * status is idempotent, so sending a mark twice does no harm. A mark the server refuses stays with its reason until
 * someone discards it, so nothing is lost silently.
 */
export interface PendingMark { path: string; eventId: string; date: string; memberId: string; name: string; status: 'attended' | 'not_attended'; error?: string }

// Per user: on a shared club tablet, trainer A's marks never go out under trainer B's session.
let owner = '';
const keyOf = (user: string) => `ov-attendance-queue:${user}`;
/** Marks from before the queue was per user: nobody knows whose they are, so nobody's session sends them unasked. */
const LEGACY = 'ov-attendance-queue';
const listeners = new Set<() => void>();
let cache: PendingMark[] | null = null;
let legacyCache: PendingMark[] | null = null;
const notify = () => listeners.forEach((l) => l());

/** Called by the shell with the signed-in user; switches to that user's queue. */
export function setQueueOwner(userId: string) {
  if (owner === userId) return;
  owner = userId;
  cache = null;
  notify();
}

function load(k: string): PendingMark[] {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '[]') as PendingMark[];
  } catch {
    return [];
  }
}
function store(k: string, marks: PendingMark[]) {
  try {
    if (marks.length || k !== LEGACY) localStorage.setItem(k, JSON.stringify(marks));
    else localStorage.removeItem(k);
  } catch {
    // Private mode or full storage: the marks still live in memory until the page closes.
  }
}

/** The queue of one user (the signed-in one by default); `cache` only ever holds the signed-in user's queue. */
function read(user = owner): PendingMark[] {
  if (!user) return [];
  if (user !== owner) return load(keyOf(user));
  return (cache ??= load(keyOf(user)));
}
function write(marks: PendingMark[], user = owner) {
  if (!user) return;
  if (user === owner) cache = marks;
  store(keyOf(user), marks);
  notify();
}

/** Ownerless marks from before the update, for the shell to offer: take them over or throw them away. */
export function useLegacyMarks() {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => (legacyCache ??= load(LEGACY)));
}
/**
 * The signed-in person takes the old marks over: merged into their queue, never replacing it. A mark that
 * contradicts one of their own (same member and date, other status) stays behind to be looked at.
 */
export function claimLegacyMarks() {
  if (!owner) return;
  const mine = read();
  const legacy = load(LEGACY);
  const conflict = (m: PendingMark) => mine.some((x) => x.path === m.path && x.status !== m.status);
  write([...mine, ...legacy.filter((m) => !conflict(m) && !mine.some((x) => x.path === m.path))]);
  legacyCache = legacy.filter(conflict);
  store(LEGACY, legacyCache);
  notify();
}
export function discardLegacyMarks() {
  legacyCache = [];
  store(LEGACY, []);
  notify();
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

const flushing = new Map<string, Promise<number>>();
/**
 * Sends the waiting marks of the signed-in user in order; stops at the first network failure, or as soon as someone
 * else signs in (their session must not send these marks). Reads and writes only this user's queue throughout.
 * Returns how many arrived.
 */
export function flushMarks() {
  const user = owner;
  if (!user) return Promise.resolve(0);
  let run = flushing.get(user);
  if (!run) {
    run = (async () => {
      let sent = 0;
      try {
        for (const m of read(user).filter((x) => !x.error)) {
          if (owner !== user) break;
          try {
            await api(m.path, { method: 'PUT', body: { status: m.status } });
            write(read(user).filter((x) => !(x.path === m.path && x.status === m.status)), user);
            sent++;
          } catch (e) {
            // No connection, or the session ran out (a long day offline): keep the mark and try again later.
            if (e instanceof ApiError && e.problem.type !== 'network' && e.problem.status !== 401) write(read(user).map((x) => (x.path === m.path ? { ...x, error: e.problem.title } : x)), user);
            else break;
          }
        }
      } finally {
        flushing.delete(user);
      }
      return sent;
    })();
    flushing.set(user, run);
  }
  return run;
}

/** Mounted once in the app shell: sends waiting marks when the browser is back online, and every 30 seconds. */
export function useAttendanceSync(userId: string) {
  const qc = useQueryClient();
  // Before the sync below (effects run in order), and not during render: it notifies the lists.
  useEffect(() => setQueueOwner(userId), [userId]);
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
  }, [qc, userId]);
}
