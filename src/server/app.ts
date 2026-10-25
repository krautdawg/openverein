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
import { bankingRoutes } from './routes/banking.ts';
import { eventRoutes } from './routes/events.ts';
import { feeRoutes } from './routes/fees.ts';
import { messageRoutes } from './routes/messages.ts';
import { documentRoutes } from './routes/documents.ts';
import { portalRoutes } from './routes/portal.ts';
import { changeRoutes } from './routes/changes.ts';
import { applicationRoutes } from './routes/applications.ts';
import { importRoutes } from './routes/imports.ts';
import { ledgerRoutes } from './routes/ledger.ts';
import { exportRoutes } from './routes/exports.ts';
import { registerIdempotency } from './http/idempotency.ts';
import { donationRoutes } from './routes/donations.ts';
import { privacyRoutes } from './routes/privacy.ts';
import { customFieldRoutes } from './routes/customFields.ts';
import { householdRoutes } from './routes/households.ts';
import { receiptRoutes } from './routes/receipts.ts';
import { duplicateRoutes } from './routes/duplicates.ts';
import { viewRoutes } from './routes/views.ts';
import { fullExportRoutes } from './routes/fullExport.ts';
import { jobRoutes } from './routes/jobs.ts';
import { reportRoutes } from './routes/reports.ts';
import { workHourRoutes } from './routes/workHours.ts';
import { assemblyRoutes } from './routes/assemblies.ts';
import { articleRoutes } from './routes/articles.ts';
import { allowanceRoutes } from './routes/allowances.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { budgetRoutes } from './routes/budget.ts';
import { pollRoutes } from './routes/polls.ts';
import { inventoryRoutes } from './routes/inventory.ts';
import { contactRoutes } from './routes/contacts.ts';
import { offerRoutes } from './routes/offers.ts';
import { taskRoutes } from './routes/tasks.ts';
import { sepaRoutes } from './routes/sepa.ts';
import { invoiceRoutes } from './routes/invoices.ts';
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
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => new Problem(429, 'rate-limited', 'Zu viele Anfragen. Bitte warte einen Moment.', `Wieder möglich in ${Math.ceil(ctx.ttl / 1000)} Sekunden.`),
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'OpenVerein API', version: '1', description: 'Jede Aktion der Oberfläche ist auch über diese API möglich. Fehler im Format RFC 9457. POST-Anfragen, die Geld-Objekte anlegen (Rechnungen, Zahlungen, Beitragsläufe, Einzüge, Buchungen, Spenden, Zuwendungsbestätigungen, DATEV-Exporte), brauchen den Header `Idempotency-Key` (8 bis 200 Zeichen): Eine Wiederholung mit demselben Schlüssel und demselben Inhalt liefert 24 Stunden lang die erste Antwort (Header `Idempotent-Replayed: true`), statt noch einmal zu buchen.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ov_session' }, token: { type: 'http', scheme: 'bearer', description: 'API-Schlüssel aus den Einstellungen (ov_…)' } } },
      security: [{ session: [] }, { token: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  const DEMO_LOCKED = /^\/api\/v1\/(users|roles|api-tokens|webhooks|files|mail\/test|mail\/resume|imports\/members|bank-accounts\/:id\/imports)(\/|$)/;
  const isApi = (url: string) => {
    const path = url.split('?')[0]!;
    return path === '/api' || path.startsWith('/api/');
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!isApi(req.url)) return;
    // CSRF: state-changing API calls must be JSON (a cross-site form cannot send that without a
    // CORS preflight we never answer) and, when the browser sends an Origin, come from this host.
    // One-click unsubscribe (RFC 8058) comes from mail programs as a form post; it carries its own token and no cookie matters.
    const oneClick = req.method === 'POST' && /^\/api\/v1\/unsubscribe\/[\w.-]+$/.test(req.url);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !oneClick) {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      // File uploads send raw bytes; octet-stream is not CORS-simple either, so it needs the same preflight.
      const upload = type === 'application/octet-stream' && /^\/api\/v1\/(files(\/[^/]+\/versions)?|receipts\/files|portal\/expenses\/files)(\?|$)/.test(req.url);
      if (type !== 'application/json' && !upload) throw new Problem(415, 'json-required', 'Schreibende Anfragen brauchen einen JSON-Body (Content-Type: application/json).');
      const origin = req.headers.origin;
      // Bearer-token clients carry no ambient credentials, so the origin check only guards cookies.
      if (origin && new URL(origin).host !== req.headers.host) throw new Problem(403, 'cross-origin', 'Anfragen von fremden Seiten werden abgelehnt.');
    }
    // The public demo stays usable for everyone: nobody may lock others out, mint keys, or host files there.
    // Matched against the route pattern, not the raw URL, so percent-encoded paths cannot slip past.
    if (config.demoMode && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && DEMO_LOCKED.test(req.routeOptions.url ?? req.url)) {
      throw new Problem(403, 'demo', 'In der Demo ist das gesperrt.', 'Zugänge, Rollen, API-Schlüssel, Uploads, Importe und Mailserver-Einstellungen lassen sich in der öffentlichen Demo nicht ändern.');
    }
    req.actor = await actorFromRequest(db, req, reply);
  });
  registerIdempotency(app, db);

  await app.register(
    async (api) => {
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
      await api.register(systemRoutes);
      await api.register(authRoutes);
      await api.register(organizationRoutes);
      await api.register(memberRoutes);
      await api.register(groupRoutes);
      await api.register(accessRoutes);
      await api.register(feeRoutes);
      await api.register(invoiceRoutes);
      await api.register(sepaRoutes);
      await api.register(bankingRoutes);
      await api.register(eventRoutes);
      await api.register(messageRoutes);
      await api.register(documentRoutes);
      await api.register(portalRoutes);
      await api.register(changeRoutes);
      await api.register(applicationRoutes);
      await api.register(importRoutes);
      await api.register(ledgerRoutes);
      await api.register(exportRoutes);
      await api.register(donationRoutes);
      await api.register(privacyRoutes);
      await api.register(customFieldRoutes);
      await api.register(householdRoutes);
      await api.register(receiptRoutes);
      await api.register(duplicateRoutes);
      await api.register(viewRoutes);
      await api.register(fullExportRoutes);
      await api.register(jobRoutes);
      await api.register(reportRoutes);
      await api.register(workHourRoutes);
      await api.register(assemblyRoutes);
      await api.register(articleRoutes);
      await api.register(allowanceRoutes);
      await api.register(webhookRoutes);
      await api.register(budgetRoutes);
      await api.register(pollRoutes);
      await api.register(inventoryRoutes);
      await api.register(contactRoutes);
      await api.register(offerRoutes);
      await api.register(taskRoutes);
    },
    { prefix: '/api/v1' },
  );

  const serveWeb = opts.serveWeb ?? existsSync(config.webDist);
  if (serveWeb) {
    await app.register(fastifyStatic, { root: config.webDist });
  }
  app.addHook('onSend', async (_req, reply, payload) => {
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html') && !reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "frame-ancestors 'self'");
    return payload;
  });
  app.setNotFoundHandler(async (req, reply) => {
    // Client-side routes get the SPA shell; unknown API paths get a problem document.
    const path = req.url.split('?')[0]!;
    if (serveWeb && req.method === 'GET' && !isApi(req.url) && !/\.\w+$/.test(path)) {
      // Pages may not be framed, except an application form on the sites the club allowed for it.
      const slug = path.match(/^\/aufnahme\/([a-z0-9-]{3,60})\/?$/)?.[1];
      const calendarId = path.match(/^\/widget\/termine\/([0-9a-f-]{36})\/?$/)?.[1];
      const origins = slug
        ? (await db.selectFrom('application_form').select('allowed_origins').where('slug', '=', slug).where('active', '=', true).executeTakeFirst())?.allowed_origins
        : calendarId
          ? (await db.selectFrom('calendar').select('public_origins').where('id', '=', calendarId).where('public', '=', true).executeTakeFirst())?.public_origins
          : undefined;
      reply.header('content-security-policy', `frame-ancestors 'self'${origins?.length ? ` ${origins.join(' ')}` : ''}`);
      return reply.sendFile('index.html');
    }
    return sendProblem(reply, new Problem(404, 'not-found', 'Diese Adresse gibt es nicht.'), req.url);
  });

  return app;
}
