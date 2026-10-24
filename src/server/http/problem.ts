import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/** RFC 9457 problem details. `type` URIs are stable identifiers, titles are German. */
export class Problem extends Error {
  readonly status: number;
  readonly type: string;
  readonly detail?: string;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, type: string, title: string, detail?: string, extra?: Record<string, unknown>) {
    super(title);
    this.status = status;
    this.type = type;
    this.detail = detail;
    this.extra = extra;
  }
}

export const unauthorized = () => new Problem(401, 'unauthorized', 'Bitte melde Dich an.');
export const forbidden = (permission: string) =>
  new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', `Benötigt: ${permission}`, { permission });
export const notFound = (what = 'Eintrag') => new Problem(404, 'not-found', `${what} nicht gefunden.`);
export const conflict = (detail: string) => new Problem(409, 'conflict', 'Konflikt mit vorhandenen Daten.', detail);

const base = 'https://openverein.org/problems/';

export function sendProblem(reply: FastifyReply, p: Problem, instance?: string) {
  return reply
    .status(p.status)
    .type('application/problem+json')
    .send({ type: base + p.type, title: p.message, status: p.status, detail: p.detail, instance, ...p.extra });
}

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof Problem) return sendProblem(reply, err, req.url);
  if (hasZodFastifySchemaValidationErrors(err)) {
    const errors = err.validation.map((v) => ({ field: v.instancePath.replace(/^\//, '').replaceAll('/', '.'), message: v.message }));
    return sendProblem(reply, new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors }), req.url);
  }
  // Postgres unique / exclusion violations are user-facing conflicts, not crashes.
  const code = (err as { code?: string }).code;
  if (code === '23505' || code === '23P01') {
    return sendProblem(reply, conflict((err as { detail?: string }).detail ?? err.message), req.url);
  }
  if (err.statusCode && err.statusCode < 500) {
    return sendProblem(reply, new Problem(err.statusCode, 'http-' + err.statusCode, err.message), req.url);
  }
  req.log.error(err);
  return sendProblem(reply, new Problem(500, 'internal', 'Da ist etwas schiefgegangen.'), req.url);
}
