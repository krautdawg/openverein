import type { FastifyReply, FastifyRequest } from 'fastify';
import { Problem } from './problem.ts';

/** A resource version from its change timestamps (several when a resource spans tables). */
export const versionOf = (...stamps: (Date | null | undefined)[]) => stamps.map((d) => (d ? d.getTime().toString(36) : '0')).join('.');

/** Sends the version as a strong ETag, so API clients can echo it in If-Match. */
export const setETag = (reply: FastifyReply, version: string) => reply.header('etag', `"${version}"`);

/**
 * Optimistic concurrency: the client must send If-Match with the version it read (call this after locking the
 * row); a missing header is 428, so a stale client cannot overwrite silently. `*` is an explicit "overwrite anyway".
 */
export function assertIfMatch(req: FastifyRequest, current: string) {
  const sent = req.headers['if-match'];
  if (typeof sent !== 'string' || !sent.trim()) throw new Problem(428, 'if-match-required', 'Für Änderungen fehlt der Header If-Match.', 'Lies den Datensatz, und schick seinen ETag als If-Match mit (oder * zum bewussten Überschreiben).', { currentVersion: current });
  if (sent.trim() === '*') return;
  // If-Match uses strong comparison: weak tags never match (RFC 9110).
  const wanted = sent.split(',').map((v) => v.trim()).filter((v) => !v.startsWith('W/')).map((v) => v.replace(/^"|"$/g, ''));
  if (!wanted.includes(current)) throw new Problem(412, 'stale', 'Jemand hat das inzwischen geändert.', 'Lade neu und mach Deine Änderung noch einmal.', { currentVersion: current });
}
