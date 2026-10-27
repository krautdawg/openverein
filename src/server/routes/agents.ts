import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminTokenCreate, personalToken, tokenCreated } from '../../shared/agents.ts';
import { assertRoom, newToken, tokenList } from '../agents/tokens.ts';
import { audit } from '../audit.ts';
import { requireActor, sha256 } from '../auth/session.ts';
import { notFound, Problem } from '../http/problem.ts';
import { level, requirePerson, requireStepUp, type Module } from '../policy.ts';

const tags = ['agents'];
const idParam = z.object({ id: z.uuid() });

/** An admin access's own tokens for its agents: they act as this access, narrowed, never more. */
export const agentRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.db;

  app.get('/personal-tokens', { schema: { tags, summary: 'Meine Agenten-Tokens mit ihren letzten Aufrufen', response: { 200: z.array(personalToken) } } }, async (req) => {
    const actor = requireActor(req);
    requirePerson(actor);
    return tokenList(db, { organizationId: actor.organizationId, userId: actor.userId! });
  });

  app.post('/personal-tokens', { schema: { tags, summary: 'Agenten-Token erstellen (wird nur einmal angezeigt; handelt mit Deinen Rechten, auf Wunsch weniger)', body: adminTokenCreate, response: { 201: tokenCreated } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePerson(actor);
    requireStepUp(actor);
    const b = req.body;
    // A cap may only name modules the access can use at all; it never widens anything (the grants decide per request).
    const cap = b.modules ? Object.fromEntries(b.modules.filter((m) => level(actor, m as Module) !== 'none').map((m) => [m, b.access])) : null;
    if (cap && !Object.keys(cap).length) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'modules', message: 'In keinem dieser Bereiche hast Du Rechte.' }] });
    const { prefix, token } = newToken('admin');
    const id = await db.transaction().execute(async (tx) => {
      const owner = { organizationId: actor.organizationId, userId: actor.userId! };
      await assertRoom(tx, owner);
      const t = await tx.insertInto('personal_token').values({ organization_id: actor.organizationId, kind: 'admin', user_id: actor.userId, name: b.name, prefix, token_hash: sha256(token), access: b.access, cap: cap ? JSON.stringify(cap) : null, expires_at: new Date(Date.now() + b.expiresInDays * 86_400_000) } as never).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'personal_token.created', entityType: 'personal_token', entityId: t.id, diff: { name: [null, b.name], access: [null, b.access], modules: [null, b.modules ?? null] } });
      return t.id;
    });
    reply.status(201);
    return { token, personalToken: (await tokenList(db, { organizationId: actor.organizationId, userId: actor.userId! })).find((t) => t.id === id)! };
  });

  app.post('/personal-tokens/:id/revoke', { schema: { tags, summary: 'Agenten-Token widerrufen', params: idParam, body: z.object({}).optional(), response: { 200: personalToken } } }, async (req) => {
    const actor = requireActor(req);
    requirePerson(actor);
    await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('personal_token').set({ revoked_at: new Date() }).where('id', '=', req.params.id).where('user_id', '=', actor.userId!).where('revoked_at', 'is', null).executeTakeFirst();
      if (Number(r.numUpdatedRows)) await audit(tx, actor.organizationId, actor, { action: 'personal_token.revoked', entityType: 'personal_token', entityId: req.params.id });
    });
    const t = (await tokenList(db, { organizationId: actor.organizationId, userId: actor.userId! })).find((x) => x.id === req.params.id);
    if (!t) throw notFound('Token');
    return t;
  });
};
