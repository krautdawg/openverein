import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { organization, organizationPatch } from '../../shared/organization.ts';
import { audit } from '../audit.ts';
import { requireUser } from '../auth/session.ts';
import type { Database } from '../db.ts';
import type { Selectable } from 'kysely';

const toDto = (o: Selectable<Database['organization']>) => ({ id: o.id, name: o.name, timeZone: o.time_zone, isDemo: o.is_demo });

export const organizationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/organization', { schema: { tags: ['organization'], summary: 'Stammdaten des Vereins', response: { 200: organization } } }, async (req) => {
    const user = requireUser(req);
    return toDto(await db.selectFrom('organization').selectAll().where('id', '=', user.organization_id).executeTakeFirstOrThrow());
  });

  app.patch(
    '/organization',
    { schema: { tags: ['organization'], summary: 'Stammdaten des Vereins ändern', body: organizationPatch, response: { 200: organization } } },
    async (req) => {
      const user = requireUser(req);
      return db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('organization').selectAll().where('id', '=', user.organization_id).forUpdate().executeTakeFirstOrThrow();
        const after = await tx
          .updateTable('organization')
          .set({ ...req.body, updated_at: new Date() })
          .where('id', '=', user.organization_id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, user.organization_id, user, { action: 'organization.update', entityType: 'organization', entityId: after.id, diff: { name: [before.name, after.name] } });
        return toDto(after);
      });
    },
  );
};
