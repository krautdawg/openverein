import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The device queue for offline attendance (Codex review G18), with a fake browser storage and API. */
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};
const calls: string[] = [];
let release: (() => void) | null = null;
vi.mock('../src/web/lib/api.ts', () => ({
  ApiError: class extends Error {},
  api: (path: string) => {
    calls.push(path);
    // The first request hangs until the test lets it go, so another person can sign in meanwhile.
    return calls.length === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  },
}));
const q = await import('../src/web/lib/offlineAttendance.ts');

const mark = (memberId: string, status: 'attended' | 'not_attended' = 'attended') => ({ path: q.pathOf('e', '2026-10-01', memberId), eventId: 'e', date: '2026-10-01', memberId, name: memberId, status });
const queue = (user: string) => JSON.parse(storage.get(`ov-attendance-queue:${user}`) ?? '[]') as { memberId: string; status: string }[];

beforeEach(() => {
  storage.clear();
  calls.length = 0;
  release = null;
  q.setQueueOwner('');
});

describe('offline attendance queue', () => {
  it('leaves old ownerless marks unclaimed, and merges them only when someone takes them over', () => {
    storage.set('ov-attendance-queue', JSON.stringify([mark('m1'), mark('m2', 'not_attended')]));
    storage.set('ov-attendance-queue:b', JSON.stringify([mark('m2', 'attended')]));
    q.setQueueOwner('b');
    // Signing in neither moves nor deletes them.
    expect(storage.has('ov-attendance-queue')).toBe(true);
    expect(queue('b')).toHaveLength(1);
    q.claimLegacyMarks();
    // m1 joins B's queue; m2 contradicts B's own mark and stays behind to be looked at.
    expect(queue('b').map((m) => m.memberId).sort()).toEqual(['m1', 'm2']);
    expect(queue('b').find((m) => m.memberId === 'm2')!.status).toBe('attended');
    expect(JSON.parse(storage.get('ov-attendance-queue')!)).toHaveLength(1);
  });

  it('stops sending when another person signs in, and never touches their queue', async () => {
    storage.set('ov-attendance-queue:a', JSON.stringify([mark('m1'), mark('m2')]));
    storage.set('ov-attendance-queue:b', JSON.stringify([mark('m1')]));
    q.setQueueOwner('a');
    const flush = q.flushMarks();
    await Promise.resolve();
    q.setQueueOwner('b');
    release!();
    expect(await flush).toBe(1);
    // A's first mark arrived and left A's queue; the second was not sent under B's session; B's queue is untouched.
    expect(calls).toHaveLength(1);
    expect(queue('a').map((m) => m.memberId)).toEqual(['m2']);
    expect(queue('b').map((m) => m.memberId)).toEqual(['m1']);
  });
});
