import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { organization, organizationPatch } from '../../shared/organization.ts';
import { audit, diffOf } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { requirePermission } from '../policy.ts';
import type { Database } from '../db.ts';
import type { Selectable } from 'kysely';

const toDto = (o: Selectable<Database['organization']>) => ({
  id: o.id,
  name: o.name,
  timeZone: o.time_zone,
  isDemo: o.is_demo,
  memberNumberPattern: o.member_number_pattern,
  noticeWeeks: o.notice_weeks,
  exitAt: o.exit_at,
});

export const organizationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/organization', { schema: { tags: ['organization'], summary: 'Stammdaten des Vereins', response: { 200: organization } } }, async (req) => {
    const actor = requireActor(req);
    return toDto(await db.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).executeTakeFirstOrThrow());
  });

  app.patch(
    '/organization',
    { schema: { tags: ['organization'], summary: 'Stammdaten des Vereins ändern', body: organizationPatch, response: { 200: organization } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'settings', 'write');
      return db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).forUpdate().executeTakeFirstOrThrow();
        const after = await tx
          .updateTable('organization')
          .set({
            ...(req.body.name !== undefined ? { name: req.body.name } : {}),
            ...(req.body.memberNumberPattern !== undefined ? { member_number_pattern: req.body.memberNumberPattern } : {}),
            ...(req.body.noticeWeeks !== undefined ? { notice_weeks: req.body.noticeWeeks } : {}),
            ...(req.body.exitAt !== undefined ? { exit_at: req.body.exitAt } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', actor.organizationId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor.organizationId, actor, { action: 'organization.update', entityType: 'organization', entityId: after.id, diff: diffOf(before as Record<string, unknown>, { name: req.body.name, member_number_pattern: req.body.memberNumberPattern, notice_weeks: req.body.noticeWeeks, exit_at: req.body.exitAt }) });
        return toDto(after);
      });
    },
  );
};
