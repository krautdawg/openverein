import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { userFromRequest } from './auth/session.ts';
import { config } from './config.ts';
import type { AppUser, Db } from './db.ts';
import { errorHandler, Problem, sendProblem } from './http/problem.ts';
import { authRoutes } from './routes/auth.ts';
import { organizationRoutes } from './routes/organization.ts';
import { systemRoutes } from './routes/system.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
  interface FastifyRequest {
    user: AppUser | null;
  }
}

export async function buildApp(db: Db, opts: { logger?: boolean; serveWeb?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.decorate('db', db);
  app.decorateRequest('user', null);

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'OpenVerein API', version: '1', description: 'Jede Aktion der Oberfläche ist auch über diese API möglich. Fehler im Format RFC 9457.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ov_session' } } },
      security: [{ session: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/')) req.user = await userFromRequest(db, req);
  });

  await app.register(
    async (api) => {
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
      await api.register(systemRoutes);
      await api.register(authRoutes);
      await api.register(organizationRoutes);
    },
    { prefix: '/api/v1' },
  );

  const serveWeb = opts.serveWeb ?? existsSync(config.webDist);
  if (serveWeb) {
    await app.register(fastifyStatic, { root: config.webDist });
  }
  app.setNotFoundHandler((req, reply) => {
    // Client-side routes get the SPA shell; unknown API paths get a problem document.
    const path = req.url.split('?')[0]!;
    if (serveWeb && req.method === 'GET' && !path.startsWith('/api/') && !/\.\w+$/.test(path)) return reply.sendFile('index.html');
    return sendProblem(reply, new Problem(404, 'not-found', 'Diese Adresse gibt es nicht.'), req.url);
  });

  return app;
}
