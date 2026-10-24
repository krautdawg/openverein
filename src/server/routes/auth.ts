import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { loginBody, me, setupBody } from '../../shared/auth.ts';
import { audit } from '../audit.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.ts';
import { createSession, destroySession, requireUser } from '../auth/session.ts';
import { Problem } from '../http/problem.ts';

const MAX_FAILS = 5;
// A real hash so unknown e-mails take as long as wrong passwords (no account enumeration by timing).
const dummyHash = await hashPassword('openverein-timing-equaliser');

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/setup', { schema: { tags: ['auth'], summary: 'Ob die Ersteinrichtung noch aussteht', response: { 200: z.object({ needsSetup: z.boolean() }) } } }, async () => {
    const org = await db.selectFrom('organization').select('id').executeTakeFirst();
    return { needsSetup: !org };
  });

  app.post(
    '/setup',
    { ...limited, schema: { tags: ['auth'], summary: 'Verein und erstes Admin-Konto anlegen (nur einmal möglich)', body: setupBody, response: { 201: me } } },
    async (req, reply) => {
      const pwProblem = passwordProblem(req.body.password);
      if (pwProblem) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', pwProblem, { errors: [{ field: 'password', message: pwProblem }] });
      const passwordHash = await hashPassword(req.body.password);
      const result = await db.transaction().execute(async (tx) => {
        // Serialise concurrent setup attempts; only the first may create the club.
        await sql`select pg_advisory_xact_lock(4711)`.execute(tx);
        if (await tx.selectFrom('organization').select('id').executeTakeFirst()) throw new Problem(409, 'already-set-up', 'Der Verein ist bereits eingerichtet.');
        const org = await tx.insertInto('organization').values({ name: req.body.clubName }).returningAll().executeTakeFirstOrThrow();
        const user = await tx
          .insertInto('app_user')
          .values({ organization_id: org.id, email: req.body.email, name: req.body.name, password_hash: passwordHash })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, org.id, user, { action: 'organization.setup', entityType: 'organization', entityId: org.id });
        return { org, user };
      });
      await createSession(db, reply, result.user.id, req.headers['user-agent']);
      reply.status(201);
      return { id: result.user.id, name: result.user.name, email: result.user.email, organization: { id: result.org.id, name: result.org.name, isDemo: result.org.is_demo } };
    },
  );

  app.post(
    '/auth/login',
    { ...limited, schema: { tags: ['auth'], summary: 'Mit E-Mail und Passwort anmelden', body: loginBody, response: { 200: me } } },
    async (req, reply) => {
      const user = await db.selectFrom('app_user').selectAll().where((eb) => eb(eb.fn('lower', ['email']), '=', req.body.email)).executeTakeFirst();
      const invalid = new Problem(401, 'invalid-credentials', 'E-Mail oder Passwort stimmen nicht.');
      if (!user || user.status !== 'active') {
        await verifyPassword(dummyHash, req.body.password);
        throw invalid;
      }
      if (user.locked_until && user.locked_until > new Date()) {
        throw new Problem(429, 'locked', 'Zu viele Fehlversuche. Bitte versuche es später noch einmal.');
      }
      if (!(await verifyPassword(user.password_hash, req.body.password))) {
        const fails = user.failed_logins + 1;
        // Progressive lockout from the 5th failure: 1, 2, 4 … minutes, capped at one hour.
        const lockedUntil = fails >= MAX_FAILS ? new Date(Date.now() + Math.min(60, 2 ** (fails - MAX_FAILS)) * 60_000) : null;
        await db.transaction().execute(async (tx) => {
          await tx.updateTable('app_user').set({ failed_logins: fails, locked_until: lockedUntil }).where('id', '=', user.id).execute();
          await audit(tx, user.organization_id, null, { action: 'auth.login_failed', entityType: 'app_user', entityId: user.id });
        });
        throw invalid;
      }
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('app_user').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', user.id).execute();
        await audit(tx, user.organization_id, user, { action: 'auth.login', entityType: 'app_user', entityId: user.id });
      });
      await createSession(db, reply, user.id, req.headers['user-agent']);
      const org = await db.selectFrom('organization').selectAll().where('id', '=', user.organization_id).executeTakeFirstOrThrow();
      return { id: user.id, name: user.name, email: user.email, organization: { id: org.id, name: org.name, isDemo: org.is_demo } };
    },
  );

  app.post('/auth/logout', { schema: { tags: ['auth'], summary: 'Abmelden', response: { 204: z.null() } } }, async (req, reply) => {
    await destroySession(db, req, reply);
    reply.status(204);
    return null;
  });

  app.get('/auth/me', { schema: { tags: ['auth'], summary: 'Das angemeldete Konto', response: { 200: me } } }, async (req) => {
    const user = requireUser(req);
    const org = await db.selectFrom('organization').selectAll().where('id', '=', user.organization_id).executeTakeFirstOrThrow();
    return { id: user.id, name: user.name, email: user.email, organization: { id: org.id, name: org.name, isDemo: org.is_demo } };
  });
};
