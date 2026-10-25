import { assertIfMatch, setETag, versionOf } from '../http/concurrency.ts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { organization, organizationPatch } from '../../shared/organization.ts';
import { audit, diffOf } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { requirePermission } from '../policy.ts';
import type { Database } from '../db.ts';
import type { Selectable } from 'kysely';

const toDto = (o: Selectable<Database['organization']>) => ({
  id: o.id,
  version: versionOf(o.updated_at as Date),
  name: o.name,
  timeZone: o.time_zone,
  isDemo: o.is_demo,
  memberNumberPattern: o.member_number_pattern,
  noticeWeeks: o.notice_weeks,
  exitAt: o.exit_at,
  street: o.street,
  postalCode: o.postal_code,
  city: o.city,
  email: o.email,
  iban: o.iban,
  bic: o.bic,
  bankName: o.bank_name,
  invoiceNumberPattern: o.invoice_number_pattern,
  cancellationNumberPattern: o.cancellation_number_pattern,
  paymentTermsDays: o.payment_terms_days,
  dunningLevels: o.dunning_levels,
  creditorId: o.creditor_id,
  prenotificationDays: o.prenotification_days,
  mailFromName: o.mail_from_name,
  mailFromAddress: o.mail_from_address,
  mailReplyTo: o.mail_reply_to,
  mailPerMinute: o.mail_per_minute,
  mailPausedReason: o.mail_paused_reason,
  electronicMandatesAgreed: o.electronic_mandates_agreed,
  joinRule: o.join_rule,
});

/** API field → column; only fields present in the body are written. */
const COLUMNS = {
  name: 'name',
  memberNumberPattern: 'member_number_pattern',
  noticeWeeks: 'notice_weeks',
  exitAt: 'exit_at',
  street: 'street',
  postalCode: 'postal_code',
  city: 'city',
  email: 'email',
  iban: 'iban',
  bic: 'bic',
  bankName: 'bank_name',
  invoiceNumberPattern: 'invoice_number_pattern',
  cancellationNumberPattern: 'cancellation_number_pattern',
  paymentTermsDays: 'payment_terms_days',
  dunningLevels: 'dunning_levels',
  creditorId: 'creditor_id',
  prenotificationDays: 'prenotification_days',
  mailFromName: 'mail_from_name',
  mailFromAddress: 'mail_from_address',
  mailReplyTo: 'mail_reply_to',
  mailPerMinute: 'mail_per_minute',
  electronicMandatesAgreed: 'electronic_mandates_agreed',
  joinRule: 'join_rule',
} as const;

export const organizationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/organization', { schema: { tags: ['organization'], summary: 'Stammdaten des Vereins (ETag für If-Match)', response: { 200: organization } } }, async (req, reply) => {
    const actor = requireActor(req);
    const o = toDto(await db.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).executeTakeFirstOrThrow());
    setETag(reply, o.version);
    return o;
  });

  app.patch(
    '/organization',
    { schema: { tags: ['organization'], summary: 'Stammdaten des Vereins ändern', body: organizationPatch, response: { 200: organization } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'settings', 'write');
      const values: Record<string, unknown> = {};
      for (const [api, col] of Object.entries(COLUMNS)) {
        const v = (req.body as Record<string, unknown>)[api];
        if (v !== undefined) values[col] = col === 'dunning_levels' ? JSON.stringify(v) : v;
      }
      return db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).forUpdate().executeTakeFirstOrThrow();
        assertIfMatch(req, versionOf(before.updated_at as Date));
        const after = await tx
          .updateTable('organization')
          .set({ ...values, updated_at: new Date() })
          .where('id', '=', actor.organizationId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor.organizationId, actor, { action: 'organization.update', entityType: 'organization', entityId: after.id, diff: diffOf(before as Record<string, unknown>, values) });
        return toDto(after);
      });
    },
  );
};
