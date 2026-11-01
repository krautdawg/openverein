import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { config } from '../config.ts';
import { DEMO_LOGIN } from '../demo/login.ts';

export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/health', { schema: { security: [], tags: ['system'], summary: 'Lebenszeichen und Datenbankverbindung', response: { 200: z.object({ ok: z.boolean() }) } } }, async () => {
    await sql`select 1`.execute(app.db);
    return { ok: true };
  });

  app.get('/config', { schema: { security: [], tags: ['system'], summary: 'Öffentliche Einstellungen der Instanz', response: { 200: z.object({ demo: z.boolean(), demoLogin: z.object({ email: z.string(), password: z.string() }).nullable(), demoResetHours: z.number().nullable() }) } } }, async () => ({
    demo: config.demoMode,
    demoLogin: config.demoMode ? DEMO_LOGIN : null,
    // How often the demo starts afresh (0: never), for the demo start page.
    demoResetHours: config.demoMode ? config.demoResetHours : null,
  }));
};
