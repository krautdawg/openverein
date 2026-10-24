import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { actorFromRequest } from './auth/session.ts';
import { config } from './config.ts';
import type { Db } from './db.ts';
import type { Actor } from './policy.ts';
import { errorHandler, Problem, sendProblem } from './http/problem.ts';
import { authRoutes } from './routes/auth.ts';
import { accessRoutes } from './routes/access.ts';
import { groupRoutes } from './routes/groups.ts';
import { memberRoutes } from './routes/members.ts';
import { organizationRoutes } from './routes/organization.ts';
import { systemRoutes } from './routes/system.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** Requests per minute and IP on login, setup and invitation endpoints. */
    authRateLimit: number;
  }
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export async function buildApp(db: Db, opts: { logger?: boolean; serveWeb?: boolean; authRateLimit?: number } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: config.trustProxy.length ? config.trustProxy : false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.decorate('db', db);
  app.decorate('authRateLimit', opts.authRateLimit ?? 10);
  app.decorateRequest('actor', null);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => new Problem(429, 'rate-limited', 'Zu viele Anfragen. Bitte warte einen Moment.', `Wieder möglich in ${Math.ceil(ctx.ttl / 1000)} Sekunden.`),
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'OpenVerein API', version: '1', description: 'Jede Aktion der Oberfläche ist auch über diese API möglich. Fehler im Format RFC 9457.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ov_session' }, token: { type: 'http', scheme: 'bearer', description: 'API-Schlüssel aus den Einstellungen (ov_…)' } } },
      security: [{ session: [] }, { token: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  const isApi = (url: string) => {
    const path = url.split('?')[0]!;
    return path === '/api' || path.startsWith('/api/');
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!isApi(req.url)) return;
    // CSRF: state-changing API calls must be JSON (a cross-site form cannot send that without a
    // CORS preflight we never answer) and, when the browser sends an Origin, come from this host.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') throw new Problem(415, 'json-required', 'Schreibende Anfragen brauchen einen JSON-Body (Content-Type: application/json).');
      const origin = req.headers.origin;
      // Bearer-token clients carry no ambient credentials, so the origin check only guards cookies.
      if (origin && new URL(origin).host !== req.headers.host) throw new Problem(403, 'cross-origin', 'Anfragen von fremden Seiten werden abgelehnt.');
    }
    req.actor = await actorFromRequest(db, req, reply);
  });

  await app.register(
    async (api) => {
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
      await api.register(systemRoutes);
      await api.register(authRoutes);
      await api.register(organizationRoutes);
      await api.register(memberRoutes);
      await api.register(groupRoutes);
      await api.register(accessRoutes);
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
    if (serveWeb && req.method === 'GET' && !isApi(req.url) && !/\.\w+$/.test(path)) return reply.sendFile('index.html');
    return sendProblem(reply, new Problem(404, 'not-found', 'Diese Adresse gibt es nicht.'), req.url);
  });

  return app;
}
