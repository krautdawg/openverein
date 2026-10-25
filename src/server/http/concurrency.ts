import type { FastifyReply, FastifyRequest } from 'fastify';
import { Problem } from './problem.ts';

/** A resource version from its change timestamps (several when a resource spans tables). */
export const versionOf = (...stamps: (Date | null | undefined)[]) => stamps.map((d) => (d ? d.getTime().toString(36) : '0')).join('.');

/** Sends the version as a strong ETag, so API clients can echo it in If-Match. */
export const setETag = (reply: FastifyReply, version: string) => reply.header('etag', `"${version}"`);

/**
 * Optimistic concurrency: when the client sends If-Match, the stored version must still be the one it read
 * (call this after locking the row). Without the header the write goes through, as before.
 */
export function assertIfMatch(req: FastifyRequest, current: string) {
  const sent = req.headers['if-match'];
  if (typeof sent !== 'string' || sent.trim() === '*') return;
  // If-Match uses strong comparison: weak tags never match (RFC 9110).
  const wanted = sent.split(',').map((v) => v.trim()).filter((v) => !v.startsWith('W/')).map((v) => v.replace(/^"|"$/g, ''));
  if (!wanted.includes(current)) throw new Problem(412, 'stale', 'Jemand hat das inzwischen geändert.', 'Lade neu und mach Deine Änderung noch einmal.', { currentVersion: current });
}
