import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { acceptInviteBody, loginBody, loginTicket, me, setupBody, totpCode } from '../../shared/auth.ts';
import { config } from '../config.ts';
import { DEMO_SEED_KEY } from '../demo/login.ts';
import { audit } from '../audit.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.ts';
import { destroySession, insertSession, requireActor, setSessionCookie, sha256 } from '../auth/session.ts';
import type { AppUser, Db } from '../db.ts';
import { Problem } from '../http/problem.ts';
import { blindIndex, decrypt, encrypt } from '../crypto.ts';
import { level, loadGrants, mfaRequired, MODULES, requireStepUp, type Grant } from '../policy.ts';
import { newSecret, otpauthUri, recoveryCodes, verifyCode } from '../auth/totp.ts';

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
    mfa: { required: !config.demoMode && !org.is_demo && mfaRequired(g), enrolled: config.demoMode || org.is_demo || !!user.totp_enabled_at },
  };
}

// Sign-in ticket between password and code: user id and expiry, signed. Valid five minutes.
const ticketFor = (userId: string) => {
  const exp = Date.now() + 5 * 60_000;
  return `${userId}.${exp}.${blindIndex(`login-ticket:${userId}:${exp}`).slice(0, 32)}`;
};
function userOfTicket(ticket: string) {
  const [id, exp, mac] = ticket.split('.');
  if (!id || !exp || !mac || Number(exp) < Date.now()) return null;
  return blindIndex(`login-ticket:${id}:${exp}`).slice(0, 32) === mac ? id : null;
}

/** Checks a TOTP code (no replay of the same step) or burns a recovery code. Returns what matched. */
export async function checkSecondFactor(tx: Db, user: AppUser, code: string): Promise<'totp' | 'recovery' | null> {
  if (!user.totp_secret_encrypted || !user.totp_enabled_at) return null;
  if (/^\d{6}$/.test(code)) {
    const step = verifyCode(decrypt(user.totp_secret_encrypted), code);
    if (step === null || (user.totp_last_step !== null && step <= user.totp_last_step)) return null;
    await tx.updateTable('app_user').set({ totp_last_step: step }).where('id', '=', user.id).execute();
    return 'totp';
  }
  const r = await tx.updateTable('totp_recovery_code').set({ used_at: new Date() }).where('user_id', '=', user.id).where('code_hash', '=', blindIndex(`recovery:${code.toLowerCase()}`)).where('used_at', 'is', null).returning('id').executeTakeFirst();
  return r ? 'recovery' : null;
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
      // On a public demo, a visitor must never get to create the club between a reset and the reseed.
      const demoSeed = req.headers['x-demo-seed'] === DEMO_SEED_KEY;
      if (config.demoMode && !demoSeed) throw new Problem(403, 'demo', 'In der Demo ist das gesperrt.');
      // Cheap check before the expensive hash; the authoritative check runs under the lock below.
      if (await db.selectFrom('organization').select('id').executeTakeFirst()) throw alreadySetUp();
      const pwProblem = passwordProblem(req.body.password);
      if (pwProblem) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', pwProblem, { errors: [{ field: 'password', message: pwProblem }] });
      const passwordHash = await hashPassword(req.body.password);
      const { user, token } = await db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(4711)`.execute(tx);
        if (await tx.selectFrom('organization').select('id').executeTakeFirst()) throw alreadySetUp();
        const org = await tx.insertInto('organization').values({ name: req.body.clubName, is_demo: demoSeed }).returningAll().executeTakeFirstOrThrow();
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
    { ...limited, schema: { ...publicRoute, tags: ['auth'], summary: 'Mit E-Mail und Passwort anmelden (mit zweitem Faktor: erst ein Ticket, dann /auth/login/totp)', body: loginBody, response: { 200: z.union([me, loginTicket]) } } },
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
        // With a second factor the password alone opens nothing; the counter resets only after the code.
        if (user.totp_enabled_at && !config.demoMode) return { user, ticket: ticketFor(user.id), token: null };
        await tx.updateTable('app_user').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', user.id).execute();
        await audit(tx, user.organization_id, userActor(user), { action: 'auth.login', entityType: 'app_user', entityId: user.id });
        return { user, ticket: null, token: await insertSession(tx, user.id, req.headers['user-agent']) };
      });
      // Locked, unknown and wrong-password attempts get the same answer.
      if (!outcome) throw invalidCredentials();
      if (outcome.ticket) return { totpRequired: true as const, ticket: outcome.ticket };
      setSessionCookie(reply, outcome.token!);
      return meOf(db, outcome.user);
    },
  );

  app.post(
    '/auth/login/totp',
    { ...limited, schema: { ...publicRoute, tags: ['auth'], summary: 'Anmeldung mit Code aus der Authenticator-App (oder Wiederherstellungscode) abschließen', body: z.object({ ticket: z.string().max(200), code: totpCode }), response: { 200: me } } },
    async (req, reply) => {
      const userId = userOfTicket(req.body.ticket);
      if (!userId) throw new Problem(401, 'ticket-expired', 'Die Anmeldung ist abgelaufen. Bitte gib Dein Passwort noch einmal ein.');
      const outcome = await db.transaction().execute(async (tx) => {
        const user = await tx.selectFrom('app_user').selectAll().where('id', '=', userId).where('status', '=', 'active').forUpdate().executeTakeFirst();
        if (!user) return null;
        if (user.locked_until && user.locked_until > new Date()) return null;
        const used = await checkSecondFactor(tx, user, req.body.code);
        if (!used) {
          // Wrong codes count toward the same progressive lockout as wrong passwords.
          const fails = user.failed_logins + 1;
          const lockedUntil = fails >= MAX_FAILS ? new Date(Date.now() + Math.min(60, 2 ** (fails - MAX_FAILS)) * 60_000) : user.locked_until;
          await tx.updateTable('app_user').set({ failed_logins: fails, locked_until: lockedUntil }).where('id', '=', user.id).execute();
          await audit(tx, user.organization_id, null, { action: 'auth.totp_failed', entityType: 'app_user', entityId: user.id });
          return null;
        }
        await tx.updateTable('app_user').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', user.id).execute();
        await audit(tx, user.organization_id, userActor(user), { action: used === 'recovery' ? 'auth.login_recovery_code' : 'auth.login', entityType: 'app_user', entityId: user.id });
        return { user, token: await insertSession(tx, user.id, req.headers['user-agent'], true) };
      });
      if (!outcome) throw new Problem(401, 'invalid-code', 'Der Code stimmt nicht.');
      setSessionCookie(reply, outcome.token);
      return meOf(db, outcome.user);
    },
  );

  // ---------- Second factor of the signed-in user ----------

  const currentSession = (req: { cookies: Record<string, string | undefined> }) => sha256(req.cookies.ov_session ?? '');

  app.post('/auth/totp/setup', { schema: { tags: ['auth'], summary: 'Zweiten Faktor einrichten: neues Geheimnis für die Authenticator-App (noch nicht aktiv)', body: z.object({}).optional(), response: { 200: z.object({ secret: z.string(), uri: z.string() }) } } }, async (req) => {
    const actor = requireActor(req);
    if (actor.kind !== 'user') throw new Problem(403, 'forbidden', 'Nur für angemeldete Zugänge.');
    // Replacing an active factor needs a fresh confirmation with the old one.
    if (actor.mfa?.enrolled && !config.demoMode) requireStepUp(actor);
    const user = await db.selectFrom('app_user').innerJoin('organization', 'organization.id', 'app_user.organization_id').select(['app_user.email', 'organization.name as org']).where('app_user.id', '=', actor.id).executeTakeFirstOrThrow();
    const secret = newSecret();
    // Stored as pending: totp_enabled_at stays as it is until /auth/totp/enable confirms a code.
    await db.updateTable('app_user').set({ totp_secret_encrypted: encrypt(`pending:${secret}`) }).where('id', '=', actor.id).execute();
    return { secret, uri: otpauthUri(secret, user.email, `OpenVerein ${user.org}`) };
  });

  app.post('/auth/totp/enable', { schema: { tags: ['auth'], summary: 'Zweiten Faktor mit einem Code bestätigen; gibt zehn Wiederherstellungscodes einmalig aus', body: z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Sechs Ziffern aus der App.') }), response: { 200: z.object({ recoveryCodes: z.array(z.string()) }) } } }, async (req) => {
    const actor = requireActor(req);
    if (actor.kind !== 'user') throw new Problem(403, 'forbidden', 'Nur für angemeldete Zugänge.');
    const codes = recoveryCodes();
    await db.transaction().execute(async (tx) => {
      const user = await tx.selectFrom('app_user').selectAll().where('id', '=', actor.id).forUpdate().executeTakeFirstOrThrow();
      const pending = user.totp_secret_encrypted ? decrypt(user.totp_secret_encrypted) : '';
      if (!pending.startsWith('pending:')) throw new Problem(409, 'no-setup', 'Starte die Einrichtung zuerst.');
      const secret = pending.slice('pending:'.length);
      const step = verifyCode(secret, req.body.code);
      if (step === null) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'code', message: 'Der Code stimmt nicht. Prüf die Uhrzeit auf dem Handy.' }] });
      await tx.updateTable('app_user').set({ totp_secret_encrypted: encrypt(secret), totp_enabled_at: new Date(), totp_last_step: step }).where('id', '=', user.id).execute();
      await tx.deleteFrom('totp_recovery_code').where('user_id', '=', user.id).execute();
      await tx.insertInto('totp_recovery_code').values(codes.map((c) => ({ user_id: user.id, code_hash: blindIndex(`recovery:${c}`) }))).execute();
      await tx.updateTable('session').set({ mfa_at: new Date() }).where('token_hash', '=', currentSession(req)).execute();
      await audit(tx, actor.organizationId, actor, { action: 'auth.totp_enabled', entityType: 'app_user', entityId: user.id });
    });
    return { recoveryCodes: codes };
  });

  app.post('/auth/step-up', { ...limited, schema: { tags: ['auth'], summary: 'Kritische Aktion mit Code bestätigen (gilt zehn Minuten)', body: z.object({ code: totpCode }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const actor = requireActor(req);
    if (actor.kind !== 'user') throw new Problem(403, 'forbidden', 'Nur für angemeldete Zugänge.');
    const ok = await db.transaction().execute(async (tx) => {
      const user = await tx.selectFrom('app_user').selectAll().where('id', '=', actor.id).forUpdate().executeTakeFirstOrThrow();
      const used = await checkSecondFactor(tx, user, req.body.code);
      await audit(tx, actor.organizationId, actor, { action: used ? `auth.step_up${used === 'recovery' ? '_recovery_code' : ''}` : 'auth.step_up_failed', entityType: 'app_user', entityId: user.id });
      if (used) await tx.updateTable('session').set({ mfa_at: new Date() }).where('token_hash', '=', currentSession(req)).execute();
      return !!used;
    });
    if (!ok) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'code', message: 'Der Code stimmt nicht.' }] });
    return { ok: true };
  });

  app.get('/auth/sessions', { schema: { tags: ['auth'], summary: 'Meine aktiven Anmeldungen', response: { 200: z.array(z.object({ id: z.string(), current: z.boolean(), userAgent: z.string().nullable(), createdAt: z.string(), lastSeenAt: z.string() })) } } }, async (req) => {
    const actor = requireActor(req);
    if (actor.kind !== 'user') return [];
    const rows = await db.selectFrom('session').select(['token_hash', 'user_agent', 'created_at', 'last_seen_at']).where('user_id', '=', actor.id).where('expires_at', '>', new Date()).orderBy('last_seen_at', 'desc').execute();
    return rows.map((r) => ({ id: r.token_hash.slice(0, 12), current: r.token_hash === currentSession(req), userAgent: r.user_agent, createdAt: r.created_at.toISOString(), lastSeenAt: r.last_seen_at.toISOString() }));
  });

  app.post('/auth/sessions/revoke-others', { schema: { tags: ['auth'], summary: 'Alle anderen Anmeldungen beenden', body: z.object({}).optional(), response: { 200: z.object({ revoked: z.number() }) } } }, async (req) => {
    const actor = requireActor(req);
    if (actor.kind !== 'user') throw new Problem(403, 'forbidden', 'Nur für angemeldete Zugänge.');
    const r = await db.deleteFrom('session').where('user_id', '=', actor.id).where('token_hash', '!=', currentSession(req)).executeTakeFirst();
    await audit(db, actor.organizationId, actor, { action: 'auth.sessions_revoked', entityType: 'app_user', entityId: actor.id });
    return { revoked: Number(r.numDeletedRows) };
  });

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
          .where('password_hash', 'is', null)
          .returningAll()
          .executeTakeFirst();
        if (!u) throw new Problem(400, 'invalid-invite', 'Der Einladungslink ist ungültig oder abgelaufen.');
        await tx.deleteFrom('session').where('user_id', '=', u.id).execute();
        await audit(tx, u.organization_id, userActor(u), { action: 'auth.invite_accepted', entityType: 'app_user', entityId: u.id });
        return { user: u, token: await insertSession(tx, u.id, req.headers['user-agent']) };
      });
      setSessionCookie(reply, token);
      return meOf(db, user);
    },
  );
};

