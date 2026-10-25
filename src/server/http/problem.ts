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

/** Safe German messages for known constraints; modules add theirs. */
export const CONSTRAINT_MESSAGES: Record<string, string> = {
  app_user_email_key: 'Es gibt schon ein Konto mit dieser E-Mail-Adresse.',
  club_group_age_move_complete: 'Für den Wechsel nach Alter braucht es Zielgruppe, Alter und Zeitpunkt.',
  club_group_age_move_not_self: 'Eine Gruppe kann nicht in sich selbst wechseln.',
  assembly_closed: 'Die Versammlung ist abgeschlossen; das Protokoll wird nicht mehr geändert.',
  article_name_active: 'Einen Artikel mit diesem Namen gibt es schon.',
  job_one_active: 'Diese Aufgabe läuft schon. Warte, bis sie fertig ist.',
  donation_on_receipt: 'Diese Spende steht auf einer gültigen Zuwendungsbestätigung. Storniere zuerst die Bestätigung.',
  donation_receipt_item_live: 'Für diese Spende gibt es schon eine gültige Zuwendungsbestätigung.',
  donation_receipt_frozen: 'Ausgestellte Zuwendungsbestätigungen werden nicht geändert, nur einmal storniert.',
  receipt_frozen: 'Der Beleg ist bezahlt und gebucht. Korrigiere mit Storno der Zahlung.',
  ledger_period_locked: 'Dieser Zeitraum ist abgeschlossen (GoBD). Buchungen und Zahlungen mit diesem Datum sind gesperrt.',
};

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
  // Postgres unique / exclusion / check violations are user-facing conflicts, not crashes.
  // The raw database detail can contain submitted values, so it is logged, never returned.
  const pg = err as { code?: string; constraint?: string };
  if (pg.code === '23505' || pg.code === '23P01' || pg.code === '23514') {
    req.log.info({ constraint: pg.constraint, code: pg.code }, 'constraint violation');
    return sendProblem(reply, conflict(CONSTRAINT_MESSAGES[pg.constraint ?? ''] ?? 'Diese Angaben kollidieren mit einem vorhandenen Eintrag.'), req.url);
  }
  // A row still referenced elsewhere: a conflict for the user, never a crash.
  if (pg.code === '23503') {
    req.log.info({ constraint: pg.constraint, code: pg.code }, 'foreign key violation');
    return sendProblem(reply, conflict('Darauf bauen noch andere Daten auf.'), req.url);
  }
  if (err.statusCode && err.statusCode < 500) {
    return sendProblem(reply, new Problem(err.statusCode, 'http-' + err.statusCode, err.message), req.url);
  }
  req.log.error(err);
  return sendProblem(reply, new Problem(500, 'internal', 'Da ist etwas schiefgegangen.'), req.url);
}
