import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { sha256 } from '../auth/session.ts';
import { config } from '../config.ts';
import { CONSTRAINT_MESSAGES, notFound, Problem } from '../http/problem.ts';
import { sendSystemMail } from '../mail/system.ts';
import { buildFullExport } from '../exports/full.ts';
import { baseUrlOf } from '../tenant.ts';
import { lockClub, purgeTenant } from '../tenantPurge.ts';
import { erasuresSince, lockErasures } from '../gdpr/service.ts';
import { createClub } from './auth.ts';

const tags = ['operator'];
const hostname = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Bitte einen Hostnamen wie verein.example.org angeben.');
const tenant = z.object({ id: z.uuid(), name: z.string(), hostname: z.string().nullable(), members: z.number(), users: z.number(), createdAt: z.string() });
const INVITE_DAYS = 7;
CONSTRAINT_MESSAGES.organization_hostname_key = 'Dieser Hostname gehört schon einem Verein.';

/**
 * Operator API for managed hosting (roadmap P2.11): creating clubs and their first admin. Only with MULTI_TENANT=true,
 * authorized by the X-Operator-Token header (not a user session: the operator is not a member of any club).
 */
export const operatorRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  const digest = (t: string) => createHash('sha256').update(t).digest();

  app.addHook('onRequest', async (req) => {
    // The matched route pattern, never the raw URL: /api/v1/%6Fperator/… routes here too (Codex/claude review G16).
    if (!(req.routeOptions.url ?? '').startsWith('/api/v1/operator/')) return;
    if (!config.multiTenant) throw notFound('Seite');
    const given = req.headers['x-operator-token'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(config.operatorToken))) throw new Problem(401, 'operator-token', 'Betreiber-Schlüssel fehlt oder stimmt nicht.');
  });

  app.get('/operator/tenants', { schema: { tags, summary: 'Vereine dieser Installation (Betreiber)', security: [], response: { 200: z.array(tenant) } } }, async () => {
    const rows = await db.selectFrom('organization').select(['id', 'name', 'hostname', 'created_at'])
      .select((eb) => [
        eb.selectFrom('member').select(sql<number>`count(*)::int`.as('n')).whereRef('member.organization_id', '=', 'organization.id').where('member.status', 'in', ['active', 'future', 'resigned']).as('members'),
        eb.selectFrom('app_user').select(sql<number>`count(*)::int`.as('n')).whereRef('app_user.organization_id', '=', 'organization.id').where('app_user.status', '=', 'active').as('users'),
      ])
      .orderBy('created_at').execute();
    return rows.map((r) => ({ id: r.id, name: r.name, hostname: r.hostname, members: Number(r.members ?? 0), users: Number(r.users ?? 0), createdAt: r.created_at.toISOString() }));
  });

  app.post('/operator/tenants', { schema: { tags, summary: 'Verein anlegen: mit Hostname und erstem Admin, der eine Einladung bekommt (Betreiber)', security: [], body: z.object({ clubName: z.string().trim().min(1).max(200), hostname, adminName: z.string().trim().min(2).max(120), adminEmail: z.email().max(254) }), response: { 201: z.object({ id: z.uuid(), hostname: z.string(), inviteLink: z.string(), mailed: z.boolean() }) } } }, async (req, reply) => {
    const b = req.body;
    if (await db.selectFrom('organization').select('id').where('hostname', '=', b.hostname).executeTakeFirst()) throw new Problem(409, 'hostname-taken', 'Dieser Hostname gehört schon einem Verein.');
    if (await db.selectFrom('app_user').select('id').where(sql<boolean>`lower(email) = ${b.adminEmail.toLowerCase()}`).executeTakeFirst()) throw new Problem(409, 'email-taken', 'Diese E-Mail-Adresse hat hier schon einen Zugang.', 'Ein Zugang gehört zu genau einem Verein; nimm eine andere Adresse.');
    const token = randomBytes(32).toString('base64url');
    const org = await db.transaction().execute(async (tx) => {
      const { org, user } = await createClub(tx, { name: b.clubName, isDemo: false, hostname: b.hostname, admin: { email: b.adminEmail, name: b.adminName, passwordHash: null } });
      await tx.updateTable('app_user').set({ invite_token_hash: sha256(token), invite_expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000) }).where('id', '=', user.id).execute();
      await audit(tx, org.id, null, { action: 'organization.provisioned', entityType: 'organization', entityId: org.id, diff: { hostname: [null, b.hostname] } });
      return org;
    });
    const inviteLink = `${baseUrlOf(org)}/einladung#${token}`;
    const mailed = await sendSystemMail(db, org.id, 'invitation', b.adminEmail, { name: b.adminName, vorname: b.adminName.split(' ')[0], link: inviteLink });
    reply.status(201);
    return { id: org.id, hostname: b.hostname, inviteLink, mailed };
  });

  app.patch('/operator/tenants/:id', { schema: { tags, summary: 'Hostname oder Namen eines Vereins ändern (Betreiber)', security: [], params: z.object({ id: z.uuid() }), body: z.object({ hostname: hostname.optional(), clubName: z.string().trim().min(1).max(200).optional() }), response: { 200: tenant.pick({ id: true, name: true, hostname: true }) } } }, async (req) => {
    const b = req.body;
    const r = await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('organization').set({ ...(b.hostname ? { hostname: b.hostname } : {}), ...(b.clubName ? { name: b.clubName } : {}), updated_at: new Date() }).where('id', '=', req.params.id).returning(['id', 'name', 'hostname']).executeTakeFirst();
      if (!r) throw notFound('Verein');
      await audit(tx, r.id, null, { action: 'organization.operator_updated', entityType: 'organization', entityId: r.id, diff: { hostname: [null, b.hostname ?? null], name: [null, b.clubName ?? null] } });
      return r;
    });
    return r;
  });

  // ---------- A club leaves (AVV section 6): hand over the export, then delete everything ----------

  app.get('/operator/tenants/:id/export.zip', { schema: { tags, summary: 'Gesamtexport eines Vereins zur Übergabe (Betreiber)', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const o = await db.selectFrom('organization').select(['id', 'hostname']).where('id', '=', req.params.id).executeTakeFirst();
    if (!o) throw notFound('Verein');
    const { file, manifest } = await buildFullExport(db, o.id);
    // A deletion that committed before the export's snapshot leaves a valid but empty archive: refuse it.
    if (manifest.counts.organization !== 1) throw notFound('Verein');
    // Checked and recorded in one transaction under the club and erasure locks (Codex review G18): a purge or an
    // erasure either committed before (the club is gone, or the count moved: refused) or waits until the export is
    // recorded, so no archive leaves with data deleted before it was handed over.
    await db.transaction().execute(async (tx) => {
      await lockClub(tx, o.id);
      await lockErasures(tx, o.id);
      if (!(await tx.selectFrom('organization').select('id').where('id', '=', o.id).executeTakeFirst())) throw notFound('Verein');
      if (await erasuresSince(tx, o.id, manifest.counts.erasure_log ?? 0)) throw new Problem(409, 'erased-meanwhile', 'Während des Exports wurde eine Person anonymisiert.', 'Rufe den Export noch einmal ab.');
      await tx.insertInto('operator_event').values({ action: 'tenant.exported', organization_id: o.id, hostname: o.hostname, detail: JSON.stringify({ sha256: createHash('sha256').update(file).digest('hex'), bytes: file.length }) }).execute();
    });
    req.log.warn({ organizationId: o.id }, 'operator downloaded full export');
    // The whole club in clear text: no cache may keep it (the operator token is not a standard auth header).
    return reply.header('cache-control', 'private, no-store').header('content-type', 'application/zip').header('content-disposition', `attachment; filename="openverein-${o.hostname ?? o.id}.zip"`).send(file);
  });

  app.delete('/operator/tenants/:id', { schema: { tags, summary: 'Verein mit allen Daten endgültig löschen; zur Bestätigung den Hostnamen angeben (Betreiber)', security: [], params: z.object({ id: z.uuid() }), body: z.object({ confirmHostname: z.string().trim().toLowerCase() }), response: { 200: z.object({ deleted: z.record(z.string(), z.number()) }) } } }, async (req) => {
    const deleted = await purgeTenant(db, req.params.id, req.body.confirmHostname);
    // The club's own audit log is gone with it; operator_event and the server log keep the fact.
    req.log.warn({ organizationId: req.params.id, deleted }, 'operator deleted club');
    return { deleted };
  });
};
