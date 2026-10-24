import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { acceptInviteBody, loginBody, me, setupBody } from '../../shared/auth.ts';
import { audit } from '../audit.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.ts';
import { destroySession, insertSession, requireActor, setSessionCookie, sha256 } from '../auth/session.ts';
import type { AppUser, Db } from '../db.ts';
import { Problem } from '../http/problem.ts';
import { level, loadGrants, MODULES, type Grant } from '../policy.ts';

const MAX_FAILS = 5;
// A real hash so unknown e-mails, locked accounts and wrong passwords all cost one Argon2 verification.
const dummyHash = await hashPassword('openverein-timing-equaliser');
const invalidCredentials = () => new Problem(401, 'invalid-credentials', 'E-Mail oder Passwort stimmen nicht.');
const publicRoute = { security: [] };

async function meOf(db: Db, user: AppUser, grants?: Grant[]) {
  const org = await db.selectFrom('organization').selectAll().where('id', '=', user.organization_id).executeTakeFirstOrThrow();
  const g = grants ?? (await loadGrants(db, user.id));
  const actor = { kind: 'user' as const, id: user.id, userId: user.id, name: user.name, organizationId: org.id, grants: g };
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    organization: { id: org.id, name: org.name, isDemo: org.is_demo },
    permissions: Object.fromEntries(MODULES.map((m) => [m, level(actor, m)])),
    roles: g.map((x) => x.roleName),
  };
}

const userActor = (u: AppUser) => ({ userId: u.id, name: u.name });

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  const limited = { config: { rateLimit: { max: app.authRateLimit, timeWindow: '1 minute' } } };

  app.get(
    '/setup',
    { schema: { ...publicRoute, tags: ['auth'], summary: 'Ob die Ersteinrichtung noch aussteht', response: { 200: z.object({ needsSetup: z.boolean() }) } } },
    async () => ({ needsSetup: !(await db.selectFrom('organization').select('id').executeTakeFirst()) }),
  );

  app.post(
    '/setup',
    { ...limited, schema: { ...publicRoute, tags: ['auth'], summary: 'Verein und erstes Admin-Konto anlegen (nur einmal möglich)', body: setupBody, response: { 201: me } } },
    async (req, reply) => {
      const alreadySetUp = () => new Problem(409, 'already-set-up', 'Der Verein ist bereits eingerichtet.');
      // Cheap check before the expensive hash; the authoritative check runs under the lock below.
      if (await db.selectFrom('organization').select('id').executeTakeFirst()) throw alreadySetUp();
      const pwProblem = passwordProblem(req.body.password);
      if (pwProblem) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', pwProblem, { errors: [{ field: 'password', message: pwProblem }] });
      const passwordHash = await hashPassword(req.body.password);
      const { user, token } = await db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(4711)`.execute(tx);
        if (await tx.selectFrom('organization').select('id').executeTakeFirst()) throw alreadySetUp();
        const org = await tx.insertInto('organization').values({ name: req.body.clubName }).returningAll().executeTakeFirstOrThrow();
        const user = await tx
          .insertInto('app_user')
          .values({ organization_id: org.id, email: req.body.email, name: req.body.name, password_hash: passwordHash })
          .returningAll()
          .executeTakeFirstOrThrow();
        await sql`select ov_seed_builtin_roles(${org.id}::uuid)`.execute(tx);
        const admin = await tx.selectFrom('role').select('id').where('organization_id', '=', org.id).where('builtin_key', '=', 'admin').executeTakeFirstOrThrow();
        await tx.insertInto('role_grant').values({ organization_id: org.id, user_id: user.id, role_id: admin.id }).execute();
        await audit(tx, org.id, userActor(user), { action: 'organization.setup', entityType: 'organization', entityId: org.id });
        return { user, token: await insertSession(tx, user.id, req.headers['user-agent']) };
      });
      setSessionCookie(reply, token);
      reply.status(201);
      return meOf(db, user);
    },
  );

  app.post(
    '/auth/login',
    { ...limited, schema: { ...publicRoute, tags: ['auth'], summary: 'Mit E-Mail und Passwort anmelden', body: loginBody, response: { 200: me } } },
    async (req, reply) => {
      // One transaction with the account row locked: concurrent guesses are serialised, so the
      // lockout counts every attempt. Failures commit their counter before the 401 is thrown.
      const outcome = await db.transaction().execute(async (tx) => {
        const user = await tx
          .selectFrom('app_user')
          .selectAll()
          .where((eb) => eb(eb.fn('lower', ['email']), '=', req.body.email))
          .forUpdate()
          .executeTakeFirst();
        const usable = user && user.status === 'active' && user.password_hash;
        const ok = await verifyPassword(usable ? user.password_hash : dummyHash, req.body.password);
        if (!user || !usable) return null;
        const locked = user.locked_until !== null && user.locked_until > new Date();
        if (!ok || locked) {
          const fails = user.failed_logins + 1;
          // Progressive lockout from the 5th failure: 1, 2, 4 … minutes, capped at one hour.
          const lockedUntil = fails >= MAX_FAILS ? new Date(Date.now() + Math.min(60, 2 ** (fails - MAX_FAILS)) * 60_000) : user.locked_until;
          await tx.updateTable('app_user').set({ failed_logins: fails, locked_until: lockedUntil }).where('id', '=', user.id).execute();
          await audit(tx, user.organization_id, null, { action: locked ? 'auth.login_locked' : 'auth.login_failed', entityType: 'app_user', entityId: user.id });
          return null;
        }
        await tx.updateTable('app_user').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', user.id).execute();
        await audit(tx, user.organization_id, userActor(user), { action: 'auth.login', entityType: 'app_user', entityId: user.id });
        return { user, token: await insertSession(tx, user.id, req.headers['user-agent']) };
      });
      // Locked, unknown and wrong-password attempts get the same answer.
      if (!outcome) throw invalidCredentials();
      setSessionCookie(reply, outcome.token);
      return meOf(db, outcome.user);
    },
  );

  app.post(
    '/auth/logout',
    { schema: { tags: ['auth'], summary: 'Abmelden', body: z.object({}).optional(), response: { 204: z.null() } } },
    async (req, reply) => {
      await destroySession(db, req, reply);
      reply.status(204);
      return null;
    },
  );

  app.get('/auth/me', { schema: { tags: ['auth'], summary: 'Das angemeldete Konto mit seinen effektiven Rechten', response: { 200: me } } }, async (req) => {
    const actor = requireActor(req);
    if (actor.kind !== 'user') throw new Problem(400, 'not-a-user', 'API-Schlüssel haben kein Benutzerkonto.');
    return meOf(db, await db.selectFrom('app_user').selectAll().where('id', '=', actor.id).executeTakeFirstOrThrow(), actor.grants);
  });

  app.post(
    '/auth/accept-invite',
    { ...limited, schema: { ...publicRoute, tags: ['auth'], summary: 'Einladung annehmen und Passwort setzen', body: acceptInviteBody, response: { 200: me } } },
    async (req, reply) => {
      const pwProblem = passwordProblem(req.body.password);
      if (pwProblem) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', pwProblem, { errors: [{ field: 'password', message: pwProblem }] });
      const passwordHash = await hashPassword(req.body.password);
      const { user, token } = await db.transaction().execute(async (tx) => {
        const u = await tx
          .updateTable('app_user')
          .set({ password_hash: passwordHash, invite_token_hash: null, invite_expires_at: null, failed_logins: 0, locked_until: null, updated_at: new Date() })
          .where('invite_token_hash', '=', sha256(req.body.token))
          .where('invite_expires_at', '>', new Date())
          .where('status', '=', 'active')
          .returningAll()
          .executeTakeFirst();
        if (!u) throw new Problem(400, 'invalid-invite', 'Der Einladungslink ist ungültig oder abgelaufen.');
        await audit(tx, u.organization_id, userActor(u), { action: 'auth.invite_accepted', entityType: 'app_user', entityId: u.id });
        return { user: u, token: await insertSession(tx, u.id, req.headers['user-agent']) };
      });
      setSessionCookie(reply, token);
      return meOf(db, user);
    },
  );
};

