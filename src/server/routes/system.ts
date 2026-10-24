import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { config } from '../config.ts';

export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/health', { schema: { security: [], tags: ['system'], summary: 'Lebenszeichen und Datenbankverbindung', response: { 200: z.object({ ok: z.boolean() }) } } }, async () => {
    await sql`select 1`.execute(app.db);
    return { ok: true };
  });

  app.get('/config', { schema: { security: [], tags: ['system'], summary: 'Öffentliche Einstellungen der Instanz', response: { 200: z.object({ demo: z.boolean() }) } } }, async () => ({
    demo: config.demoMode,
  }));
};
