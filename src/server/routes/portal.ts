import { customText } from '../../shared/customFields.ts';
import { baseUrlOf, tenantForRequest } from '../tenant.ts';
import { uploadName } from '../http/upload.ts';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { correction, generate } from 'lean-qr';
import { toSvgSource } from 'lean-qr/extras/svg';
import { sql } from 'kysely';
import { z } from 'zod';
import { email as emailSchema } from '../../shared/auth.ts';
import { expenseClaimInput } from '../../shared/expenses.ts';
import { formatDate, proposeExitDate } from '../../shared/dates.ts';
import { isValidIban, normalizeIban } from '../../shared/iban.ts';
import { postalCodeProblem } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import { sha256 } from '../auth/session.ts';
import { config } from '../config.ts';
import { blindIndex, encrypt } from '../crypto.ts';
import type { ChangeField, Db } from '../db.ts';
import { getBlob, putBlob } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { epcPayload } from '../invoices/pdf.ts';
import { storedPdf, type IssueSnapshot } from '../invoices/service.ts';
import { sendSystemMail } from '../mail/system.ts';
import { orgToday } from '../members/query.ts';
import { resolvePortalFeatures, type PortalFeature } from '../../shared/organization.ts';
import { membershipCertificate } from '../members/certificate.ts';
import { eligibleMembers, pollResults } from './polls.ts';
import { addDays as addDaysIso } from '../../shared/dates.ts';

export const PORTAL_COOKIE = 'ov_portal';
const PORTAL_IDLE_MS = 30 * 24 * 60 * 60 * 1000; // members stay signed in on their phone for 30 days of use
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const tags = ['portal'];

const emailKey = (e: string) => blindIndex(`login:${e.trim().toLowerCase()}`);
// Keyed with the data key, so a database dump alone cannot reverse the million possible codes.
const codeHash = (codeId: string, code: string) => blindIndex(`code:${codeId}:${code}`);
/** Wrong codes allowed per address and day, across all its codes. */
const MAX_FAILURES_PER_DAY = 10;
const CURRENT = ['active', 'future', 'resigned'] as const;

/** Fields members may change themselves; phone applies at once, the rest waits for an admin. */
export const IMMEDIATE: ChangeField[] = ['phone'];
const changeBody = z.discriminatedUnion('field', [
  z.object({ memberId: z.uuid(), field: z.enum(['first_name', 'last_name', 'email', 'phone']), value: z.string().trim().max(200) }),
  // Street, postal code and city travel together, so a half-accepted address cannot happen.
  z.object({ memberId: z.uuid(), field: z.literal('address'), street: z.string().trim().min(1, 'Bitte ausfüllen.').max(200), postalCode: z.string().trim().min(3, 'Bitte ausfüllen.').max(20), city: z.string().trim().min(1, 'Bitte ausfüllen.').max(100) }),
  // A new account needs its holder: someone else's account needs a new signed mandate.
  z.object({ memberId: z.uuid(), field: z.literal('iban'), iban: z.string().max(50), accountHolder: z.string().trim().min(2, 'Bitte den Namen der Kontoinhaberin oder des Kontoinhabers angeben.').max(70) }),
]);

/** Issues a 6-digit code for an address. Returns the code; only its keyed hash is stored. */
export async function issueLoginCode(db: Db, organizationId: string, email: string, issuedBy: string | null) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  await db.insertInto('login_code').values({ id, organization_id: organizationId, email_hash: emailKey(email), code_hash: codeHash(id, code), expires_at: new Date(Date.now() + (issuedBy ? 24 * 3_600_000 : CODE_TTL_MS)), issued_by: issuedBy }).execute();
  return code;
}

/** How a pending change reads for the member. */
function pendingText(field: ChangeField, value: string) {
  if (field === 'iban') return 'neue Bankverbindung';
  if (field === 'address') {
    const a = JSON.parse(value) as { street: string; postalCode: string; city: string };
    return `${a.street}, ${a.postalCode} ${a.city}`;
  }
  return value;
}

/** Removes old sign-in codes and expired portal sessions (hourly). */
export async function pruneSignIns(db: Db) {
  await db.deleteFrom('login_code').where('created_at', '<', new Date(Date.now() - 7 * 86_400_000)).execute();
  await db.deleteFrom('portal_session').where('expires_at', '<', new Date()).execute();
  await db.deleteFrom('portal_verify_failure').where('day', '<', sql<string>`current_date - 2`).execute();
}

export const portalRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** The signed-in address, every current membership registered under it, and the members of households it pays for (proxy). */
  async function portalUser(req: FastifyRequest, reply: FastifyReply) {
    const token = req.cookies[PORTAL_COOKIE];
    const s = token ? await db.selectFrom('portal_session').selectAll().where('token_hash', '=', sha256(token)).where('expires_at', '>', new Date()).executeTakeFirst() : undefined;
    if (!s) throw new Problem(401, 'unauthenticated', 'Bitte melde Dich im Mitgliederportal an.');
    if (Date.now() - s.last_seen_at.getTime() > 60_000) {
      await db.updateTable('portal_session').set({ last_seen_at: new Date(), expires_at: new Date(Date.now() + PORTAL_IDLE_MS) }).where('token_hash', '=', s.token_hash).execute();
      reply.setCookie(PORTAL_COOKIE, token!, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: PORTAL_IDLE_MS / 1000 });
    }
    const members = await db
      .selectFrom('member')
      .innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id as memberId', 'member.person_id as personId', 'member.status', 'member.membership_number', 'member.join_date', 'member.exit_date', 'member.notice_date', 'person.first_name', 'person.last_name', 'person.company_name', 'person.kind', 'person.email', 'person.phone', 'person.street', 'person.postal_code', 'person.city', 'person.country', 'person.custom'])
      .select(sql<boolean>`lower(coalesce(person.email, '')) <> lower(${s.email})`.as('viaHousehold'))
      .where('member.organization_id', '=', s.organization_id)
      .where((eb) => eb.or([
        eb(sql`lower(person.email)`, '=', s.email.toLowerCase()),
        // The payer of a household manages its members (children, partners without their own access).
        eb('member.household_id', 'in', eb.selectFrom('household').innerJoin('person as payer', 'payer.id', 'household.payer_person_id').select('household.id').where('household.organization_id', '=', s.organization_id).where(sql<boolean>`lower(payer.email) = lower(${s.email})`)),
      ]))
      .where('member.status', 'in', [...CURRENT])
      .orderBy('person.first_name')
      .execute();
    // What each membership may do here: the club's switches, overridden by the member's current groups.
    const club = (await db.selectFrom('organization').select('portal_features').where('id', '=', s.organization_id).executeTakeFirstOrThrow()).portal_features as Record<string, boolean>;
    const today = await orgToday(db, s.organization_id);
    const overrides = members.length
      ? await db.selectFrom('group_membership').innerJoin('club_group', 'club_group.id', 'group_membership.group_id').select(['group_membership.member_id', 'club_group.portal_overrides'])
        .where('group_membership.member_id', 'in', members.map((m) => m.memberId)).where('group_membership.valid_from', '<=', today).where((eb) => eb.or([eb('group_membership.valid_to', 'is', null), eb('group_membership.valid_to', '>=', today)])).where('club_group.archived_at', 'is', null).execute()
      : [];
    const withFeatures = members.map((m) => ({ ...m, features: resolvePortalFeatures(club, overrides.filter((o) => o.member_id === m.memberId).map((o) => o.portal_overrides as Record<string, string>)) }));
    return { session: s, organizationId: s.organization_id, email: s.email, members: withFeatures };
  }
  type PortalUser = Awaited<ReturnType<typeof portalUser>>;
  const ownMember = (u: PortalUser, memberId: string) => {
    const m = u.members.find((x) => x.memberId === memberId);
    if (!m) throw notFound('Mitgliedschaft');
    return m;
  };
  const requireFeature = (m: PortalUser['members'][number], f: PortalFeature) => {
    if (!m.features[f]) throw new Problem(403, 'portal-feature-off', 'Das bietet Dein Verein im Portal nicht an.', 'Wende Dich bitte direkt an den Verein.');
  };

  // ---------- Sign-in ----------

  app.post(
    '/portal/auth/request-code',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Anmeldecode per E-Mail anfordern (antwortet immer gleich, damit niemand Adressen ausprobieren kann)', security: [], body: z.object({ email: emailSchema }) } },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      const org = await tenantForRequest(db, req);
      if (!org) return { ok: true };
      const own = await db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select('member.id').where('member.organization_id', '=', org.id).where(sql<boolean>`lower(person.email) = ${email}`).where('member.status', 'in', [...CURRENT]).executeTakeFirst();
      // A parent who pays for a child member signs in too, without being a member (the portal then shows the child).
      const member = own ?? (await db.selectFrom('household').innerJoin('person as payer', 'payer.id', 'household.payer_person_id').innerJoin('member', 'member.household_id', 'household.id').select('household.id').where('household.organization_id', '=', org.id).where(sql<boolean>`lower(payer.email) = ${email}`).where('member.status', 'in', [...CURRENT]).executeTakeFirst());
      // At most three codes per address and hour, so the endpoint cannot be used to flood an inbox.
      const recent = await db.selectFrom('login_code').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', org.id).where('email_hash', '=', emailKey(email)).where('created_at', '>', new Date(Date.now() - 3_600_000)).executeTakeFirstOrThrow();
      // The public demo sends no mail, so it shows the code right away (demo members only exist there).
      if (config.demoMode && member) return { ok: true, demoCode: await issueLoginCode(db, org.id, email, null) };
      if (member && recent.n < 3) {
        // Not awaited: the answer must take as long for members as for unknown addresses.
        void issueLoginCode(db, org.id, email, null)
          .then((code) => sendSystemMail(db, org.id, 'login_code', email, { code, link: `${baseUrlOf(org)}/portal/anmelden#${new URLSearchParams({ email, code })}` }))
          .catch((err: unknown) => req.log.error(err, 'login code mail failed'));
      }
      return { ok: true };
    },
  );

  app.post(
    '/portal/auth/verify',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Mit Code anmelden', security: [], body: z.object({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, 'Der Code hat sechs Ziffern.') }) } },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const wrong = () => new Problem(400, 'invalid-code', 'Der Code stimmt nicht oder ist abgelaufen.', 'Fordere bei Bedarf einen neuen an.');
      const key = emailKey(email);
      // Codes, failures and the lock belong to the club of this address (host): one club's attempts touch no other's.
      const org = await tenantForRequest(db, req);
      if (!org) throw wrong();
      const failureKey = blindIndex(`login:${org.id}:${email}`);
      const token = await db.transaction().execute(async (tx) => {
        // Serialise sign-ins per address so the failure budget cannot be raced.
        await sql`select pg_advisory_xact_lock(hashtext(${`portal:${org.id}:${key}`}))`.execute(tx);
        // Failures count per address and day whether or not a code exists, so the answers do not tell members from
        // non-members (Codex review of #9).
        const failures = await tx.selectFrom('portal_verify_failure').select('n').where('email_hash', '=', failureKey).where('day', '=', sql<string>`current_date`).executeTakeFirst();
        if ((failures?.n ?? 0) >= MAX_FAILURES_PER_DAY) throw new Problem(429, 'too-many-attempts', 'Zu viele falsche Codes für diese Adresse.', 'Versuch es morgen wieder oder bitte den Verein um einen Code.');
        const fail = () => tx.insertInto('portal_verify_failure').values({ email_hash: failureKey, day: sql<string>`current_date`, n: 1 }).onConflict((oc) => oc.columns(['email_hash', 'day']).doUpdateSet({ n: sql<number>`portal_verify_failure.n + 1` })).execute();
        const live = await tx.selectFrom('login_code').selectAll().where('organization_id', '=', org.id).where('email_hash', '=', key).where('consumed_at', 'is', null).where('expires_at', '>', new Date()).where('attempts', '<', MAX_ATTEMPTS).orderBy('created_at', 'desc').execute();
        // Any live code counts (a mailed one and one the club handed out can both be valid).
        const c = live.find((x) => timingSafeEqual(Buffer.from(x.code_hash), Buffer.from(codeHash(x.id, req.body.code))));
        if (!c) {
          await fail();
          if (live.length) await tx.updateTable('login_code').set({ attempts: live[0]!.attempts + 1 }).where('id', '=', live[0]!.id).execute();
          return null;
        }
        await tx.updateTable('login_code').set({ consumed_at: new Date() }).where('organization_id', '=', org.id).where('email_hash', '=', key).where('consumed_at', 'is', null).execute();
        const t = randomBytes(32).toString('base64url');
        await tx.insertInto('portal_session').values({ token_hash: sha256(t), organization_id: c.organization_id, email, expires_at: new Date(Date.now() + PORTAL_IDLE_MS) }).execute();
        await audit(tx, c.organization_id, null, { action: 'portal.signed_in', entityType: 'login_code', entityId: c.id });
        return t;
      });
      if (!token) throw wrong();
      reply.setCookie(PORTAL_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: PORTAL_IDLE_MS / 1000 });
      return { ok: true };
    },
  );

  app.post('/portal/auth/logout', { schema: { tags, summary: 'Abmelden', security: [], body: z.object({}).optional() } }, async (req, reply) => {
    const token = req.cookies[PORTAL_COOKIE];
    if (token) await db.deleteFrom('portal_session').where('token_hash', '=', sha256(token)).execute();
    reply.clearCookie(PORTAL_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------- Pages ----------

  app.get('/portal/me', { schema: { tags, summary: 'Meine Mitgliedschaften (alle unter meiner E-Mail-Adresse)', security: [] } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const org = await db.selectFrom('organization').select(['name', 'email', 'notice_weeks', 'exit_at', 'is_demo']).where('id', '=', u.organizationId).executeTakeFirstOrThrow();
    const today = await orgToday(db, u.organizationId);
    const ids = u.members.map((m) => m.memberId);
    const groups = ids.length
      ? await db.selectFrom('group_membership').innerJoin('club_group', 'club_group.id', 'group_membership.group_id').select(['group_membership.member_id', 'club_group.name', 'club_group.color']).where('group_membership.member_id', 'in', ids).where('group_membership.valid_from', '<=', today).where((eb) => eb.or([eb('group_membership.valid_to', 'is', null), eb('group_membership.valid_to', '>=', today)])).where('club_group.archived_at', 'is', null).execute()
      : [];
    const mandates = ids.length ? await db.selectFrom('sepa_mandate').select(['person_id', 'reference', 'iban_last4', 'signed_on', 'status']).where('person_id', 'in', u.members.map((m) => m.personId)).where('status', 'in', ['active', 'pending_evidence']).execute() : [];
    // Only fields the club shows to members, never sensitive ones (one address can hold several people); values as text.
    const shown = await db.selectFrom('custom_field').select(['id', 'key', 'label', 'type']).where('organization_id', '=', u.organizationId).where('visible_to_member', '=', true).where('sensitive', '=', false).where('archived_at', 'is', null).orderBy('position').orderBy('label').execute();
    const pending = ids.length ? await db.selectFrom('change_request').select(['member_id', 'field', 'new_value', 'requested_at']).where('member_id', 'in', ids).where('status', '=', 'pending').execute() : [];
    return {
      email: u.email,
      // The contact shows if it is on for any of the memberships under this address.
      club: { name: org.name, email: u.members.some((m) => m.features.contact) ? org.email : null, isDemo: org.is_demo },
      members: u.members.map((m) => ({
        memberId: m.memberId,
        /** managed as the household's payer, not the member's own address */
        managed: m.viaHousehold,
        name: m.kind === 'organisation' ? m.company_name : [m.first_name, m.last_name].filter(Boolean).join(' '),
        firstName: m.first_name,
        lastName: m.last_name,
        number: m.membership_number,
        status: m.status,
        joinDate: m.join_date,
        exitDate: m.exit_date,
        email: m.email,
        phone: m.phone,
        street: m.street,
        postalCode: m.postal_code,
        city: m.city,
        groups: groups.filter((g) => g.member_id === m.memberId).map((g) => ({ name: g.name, color: g.color })),
        custom: shown.map((f) => ({ key: f.key, label: f.label, value: customText(f.type, m.custom[f.id]) })),
        features: m.features,
        mandate: !m.features.mandate ? null : mandates.filter((x) => x.person_id === m.personId).map((x) => ({ reference: x.reference, ibanLast4: x.iban_last4, signedOn: x.signed_on, status: x.status }))[0] ?? null,
        pending: pending.filter((p) => p.member_id === m.memberId).map((p) => ({ field: p.field, value: pendingText(p.field, p.new_value), requestedAt: p.requested_at.toISOString() })),
        resignationProposal: m.status === 'resigned' ? null : proposeExitDate(today, org.notice_weeks, org.exit_at),
      })),
    };
  });

  /** Invoices addressed to any person under this address. */
  /**
   * Invoices addressed to the signed-in person's own memberships, and household invoices to them as payer (also a
   * payer who is no member). A household invoice covers the managed members too: it shows only if every one of
   * them may see invoices (deny wins).
   */
  async function ownInvoices(u: PortalUser) {
    const managed = u.members.filter((m) => m.viaHousehold);
    const householdAllowed = managed.every((m) => m.features.invoices);
    const own = u.members.filter((m) => !m.viaHousehold && m.features.invoices).map((m) => m.personId);
    const payers = managed.length && householdAllowed
      ? (await db.selectFrom('person').select('id').where('organization_id', '=', u.organizationId).where(sql<boolean>`lower(email) = lower(${u.email})`).execute()).map((p) => p.id)
      : [];
    const persons = [...new Set([...own, ...payers])];
    if (!persons.length) return [];
    const rows = await db.selectFrom('invoice').selectAll().where('organization_id', '=', u.organizationId).where('recipient_person_id', 'in', persons).where('status', '!=', 'draft').orderBy('issue_date', 'desc').execute();
    return rows.filter((i) => !(i.recipient as IssueSnapshot | null)?.household || householdAllowed);
  }

  app.get('/portal/invoices', { schema: { tags, summary: 'Meine Rechnungen', security: [] } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    return (await ownInvoices(u)).map((i) => ({ id: i.id, number: i.number, kind: i.kind, status: i.status, issueDate: i.issue_date, dueDate: i.due_date, totalCents: i.total_cents, openCents: ['open', 'partially_paid'].includes(i.status) ? i.total_cents - i.paid_cents : 0, directDebit: (i.recipient as IssueSnapshot | null)?.paymentMethod === 'direct_debit' }));
  });

  async function ownInvoice(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const u = await portalUser(req, reply);
    const inv = (await ownInvoices(u)).find((i) => i.id === req.params.id);
    if (!inv) throw notFound('Rechnung');
    return { u, inv };
  }

  app.get('/portal/invoices/:id/pdf', { schema: { tags, summary: 'Rechnung als PDF', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const { u, inv } = await ownInvoice(req, reply);
    const { pdf, number } = await storedPdf(db, u.organizationId, inv.id);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${number}.pdf"`).header('cache-control', 'private, no-store').send(pdf);
  });

  app.get('/portal/members/:id/certificate.pdf', { schema: { tags, summary: 'Eigene Mitgliedsbescheinigung als PDF', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const m = ownMember(u, req.params.id);
    // A payer manages children's memberships; an adult with their own address gets their certificate themselves.
    if (m.viaHousehold && m.email) throw new Problem(403, 'own-access', 'Die Bescheinigung holt sich das Mitglied selbst.', `${m.first_name ?? 'Das Mitglied'} hat eine eigene E-Mail-Adresse und kann sich selbst im Portal anmelden.`);
    const { pdf } = await membershipCertificate(db, u.organizationId, m.memberId, { birthDate: !m.viaHousehold });
    return reply.header('content-type', 'application/pdf').header('content-disposition', 'attachment; filename="Mitgliedsbescheinigung.pdf"').header('cache-control', 'private, no-store').send(pdf);
  });

  app.get('/portal/invoices/:id/qr.svg', { schema: { tags, summary: 'GiroCode zum Bezahlen per Banking-App (nur offene Rechnungen)', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const { inv } = await ownInvoice(req, reply);
    const snap = inv.recipient as IssueSnapshot | null;
    const open = inv.total_cents - inv.paid_cents;
    // Direct debit invoices are collected; a transfer code would make members pay twice.
    if (!['open', 'partially_paid'].includes(inv.status) || !snap?.org.iban || open <= 0 || snap.paymentMethod === 'direct_debit') throw notFound('Zahlcode');
    const code = generate(epcPayload({ name: snap.org.name, iban: snap.org.iban, bic: snap.org.bic, amountCents: open, remittance: inv.number ?? '' }), { minCorrectionLevel: correction.M });
    return reply.header('content-type', 'image/svg+xml').header('cache-control', 'private, no-store').send(toSvgSource(code, { on: '#14202e', off: '#ffffff', padX: 4, padY: 4 }));
  });

  // ---------- Polls ----------
  /** Open polls (and the last closed ones with results) for the signed-in memberships that may answer. */
  app.get('/portal/polls', { schema: { tags, summary: 'Umfragen für meine Mitgliedschaften', security: [] } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const today = await orgToday(db, u.organizationId);
    const polls = await db.selectFrom('poll').selectAll().where('organization_id', '=', u.organizationId).where('closes_on', '>=', addDaysIso(today, -30)).orderBy('closes_on').execute();
    const ids = u.members.map((m) => m.memberId);
    const out = [];
    for (const p of polls) {
      const allowed = ids.length ? (await eligibleMembers(db, u.organizationId, p.group_id, today).select('member.id').where('member.id', 'in', ids).execute()).map((r) => r.id) : [];
      if (!allowed.length) continue;
      const mine = await db.selectFrom('poll_vote').select(['member_id', 'choices']).where('poll_id', '=', p.id).where('member_id', 'in', allowed).execute();
      const open = p.closes_on >= today;
      // Results only after the poll closed, so early answers do not steer later ones.
      const results = open ? null : (await pollResults(db, u.organizationId, p.id))[0]!;
      out.push({ id: p.id, question: p.question, description: p.description, options: p.options, multiple: p.multiple, closesOn: p.closes_on, open, members: allowed.map((memberId) => ({ memberId, choices: mine.find((v) => v.member_id === memberId)?.choices ?? null })), results: results && { answered: results.answered, eligible: results.eligible, counts: results.counts } });
    }
    return out;
  });

  app.post('/portal/polls/:id/vote', { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Antworten (bis zum Ende änderbar)', security: [], params: z.object({ id: z.uuid() }), body: z.object({ memberId: z.uuid(), choices: z.array(z.number().int().min(0).max(19)).min(1).max(20) }) } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const m = ownMember(u, req.body.memberId);
    const today = await orgToday(db, u.organizationId);
    // In one transaction with the poll row share-locked: closing the poll (an update) waits for votes in flight, and a
    // vote after the close sees it closed.
    await db.transaction().execute(async (tx) => {
      const p = await tx.selectFrom('poll').selectAll().where('id', '=', req.params.id).where('organization_id', '=', u.organizationId).forShare().executeTakeFirst();
      if (!p) throw notFound('Umfrage');
      if (p.closes_on < today) throw new Problem(409, 'closed', 'Die Umfrage ist beendet.');
      if (!(await eligibleMembers(tx, u.organizationId, p.group_id, today).select('member.id').where('member.id', '=', m.memberId).executeTakeFirst())) throw new Problem(403, 'forbidden', 'Diese Umfrage richtet sich an eine andere Gruppe.');
      const choices = [...new Set(req.body.choices)].sort((a, b) => a - b);
      if (choices.some((c) => c >= p.options.length) || (!p.multiple && choices.length > 1)) throw new Problem(400, 'validation', p.multiple ? 'Ungültige Antwort.' : 'Bitte nur eine Antwort wählen.');
      await tx.insertInto('poll_vote').values({ poll_id: p.id, member_id: m.memberId, choices }).onConflict((oc) => oc.columns(['poll_id', 'member_id']).doUpdateSet({ choices, voted_at: new Date() })).execute();
    });
    return reply.status(204).send();
  });

  // ---------- Expense claims (Auslagen) ----------
  // Receipt uploads send raw bytes (allowed for this path only, see the CSRF guard in app.ts).
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  const EXPENSE_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

  app.post('/portal/expenses/files', { schema: { tags, summary: 'Beleg für eine Auslage hochladen (PDF oder Foto, höchstens 10 MB; Dateityp im Header X-File-Type)', security: [], querystring: z.object({ name: z.string().trim().min(1).max(200).optional() }), response: { 201: z.object({ id: z.uuid() }) } } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Problem(400, 'empty', 'Die Datei ist leer.');
    if (bytes.length > 10 * 1024 * 1024) throw new Problem(413, 'too-large', 'Die Datei ist größer als 10 MB.');
    const type = String(req.headers['x-file-type'] ?? '');
    if (!EXPENSE_FILE_TYPES.includes(type)) throw new Problem(415, 'file-type', 'Bitte ein PDF oder ein Foto (JPG, PNG) hochladen.');
    const sha = await putBlob(bytes);
    // Temporary until a claim uses it; abandoned uploads expire like other temporary files.
    const f = await db.insertInto('file').values({ organization_id: u.organizationId, folder_id: null, member_id: null, purpose: 'receipt', sha256: sha, size_bytes: bytes.length, mime_type: type, name: uploadName(req, req.query.name, 200), retention_class: 'temporary', retain_until: null, uploaded_by: null }).returning('id').executeTakeFirstOrThrow();
    reply.status(201);
    return { id: f.id };
  });

  app.post('/portal/expenses', { schema: { tags, summary: 'Auslage zur Erstattung einreichen', security: [], body: expenseClaimInput, response: { 201: z.object({ id: z.uuid() }) } } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const m = ownMember(u, req.body.memberId);
    const b = req.body;
    // Money already spent: a future date is a typo (and would pick the wrong year and tax rate).
    if (b.spentOn > (await orgToday(db, u.organizationId))) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'spentOn', message: 'Das Datum liegt in der Zukunft.' }] });
    const id = await db.transaction().execute(async (tx) => {
      // Only a fresh, unused upload of this club: a claim cannot pick up somebody else's receipt.
      const f = await tx.selectFrom('file').select('id').where('id', '=', b.fileId).where('organization_id', '=', u.organizationId).where('purpose', '=', 'receipt').where('uploaded_by', 'is', null).where('retention_class', '=', 'temporary').where('created_at', '>', new Date(Date.now() - 3_600_000)).forUpdate().executeTakeFirst();
      if (!f) throw new Problem(409, 'file-gone', 'Der Beleg ist nicht mehr da. Lade ihn bitte noch einmal hoch.');
      const c = await tx.insertInto('expense_claim').values({ organization_id: u.organizationId, member_id: m.memberId, person_id: m.personId, purpose: b.purpose, spent_on: b.spentOn, amount_cents: b.amountCents, account_holder: b.accountHolder, iban_encrypted: encrypt(b.iban), file_id: f.id }).returning('id').executeTakeFirstOrThrow();
      // Kept like any receipt once claimed (8 years from the end of the year).
      await tx.updateTable('file').set({ retention_class: 'voucher', retain_until: `${Number(b.spentOn.slice(0, 4)) + 8}-12-31` }).where('id', '=', f.id).execute();
      await audit(tx, u.organizationId, null, { action: 'expense_claim.submitted', entityType: 'expense_claim', entityId: c.id, diff: { amountCents: [null, b.amountCents] } });
      return c.id;
    });
    reply.status(201);
    return { id };
  });

  app.get('/portal/expenses', { schema: { tags, summary: 'Meine eingereichten Auslagen', security: [] } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const persons = u.members.map((m) => m.personId);
    if (!persons.length) return [];
    const rows = await db.selectFrom('expense_claim').select(['id', 'member_id', 'purpose', 'spent_on', 'amount_cents', 'status', 'reject_reason', 'created_at']).where('organization_id', '=', u.organizationId).where('person_id', 'in', persons).orderBy('created_at', 'desc').limit(50).execute();
    return rows.map((r) => ({ id: r.id, memberId: r.member_id, purpose: r.purpose, spentOn: r.spent_on, amountCents: Number(r.amount_cents), status: r.status, rejectReason: r.reject_reason, createdAt: r.created_at.toISOString() }));
  });

  app.get('/portal/documents', { schema: { tags, summary: 'Dokumente, die der Verein mit Mitgliedern teilt', security: [] } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    if (!u.members.length) return [];
    const rows = await db.selectFrom('file').innerJoin('folder', 'folder.id', 'file.folder_id').select(['file.id', 'file.name', 'file.size_bytes', 'file.mime_type', 'file.created_at', 'folder.name as folder']).where('file.organization_id', '=', u.organizationId).where('folder.share_with_members', '=', true).where('file.superseded_at', 'is', null).orderBy('folder.name').orderBy('file.name').execute();
    return rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder, sizeBytes: Number(r.size_bytes), mimeType: r.mime_type, createdAt: r.created_at.toISOString() }));
  });

  app.get('/portal/documents/:id', { schema: { tags, summary: 'Geteiltes Dokument herunterladen', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const f = u.members.length ? await db.selectFrom('file').innerJoin('folder', 'folder.id', 'file.folder_id').select(['file.sha256', 'file.name', 'file.mime_type']).where('file.id', '=', req.params.id).where('file.organization_id', '=', u.organizationId).where('folder.share_with_members', '=', true).where('file.superseded_at', 'is', null).executeTakeFirst() : undefined;
    if (!f) throw notFound('Dokument');
    const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(f.mime_type);
    return reply
      .header('content-type', inline ? f.mime_type : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('x-content-type-options', 'nosniff')
      // Chrome's PDF viewer refuses sandboxed documents.
      .header('content-security-policy', f.mime_type === 'application/pdf' ? "default-src 'none'" : "default-src 'none'; sandbox")
      .send(await getBlob(f.sha256));
  });

  // A donation receipt is the donor's own tax document: only for memberships under their own address, never via the household payer.
  const ownPersons = (u: PortalUser) => u.members.filter((m) => !m.viaHousehold).map((m) => m.personId);

  app.get('/portal/donation-receipts', { schema: { tags, summary: 'Meine Zuwendungsbestätigungen', security: [], response: { 200: z.array(z.object({ id: z.uuid(), number: z.string(), issuedOn: z.string(), totalCents: z.number(), status: z.enum(['issued', 'cancelled']) })) } } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const persons = ownPersons(u);
    if (!persons.length) return [];
    const rows = await db.selectFrom('donation_receipt').select(['id', 'number', 'issued_on', 'total_cents', 'status']).where('organization_id', '=', u.organizationId).where('person_id', 'in', persons).orderBy('issued_on', 'desc').execute();
    return rows.map((r) => ({ id: r.id, number: r.number, issuedOn: r.issued_on, totalCents: Number(r.total_cents), status: r.status }));
  });

  app.get('/portal/donation-receipts/:id/pdf', { schema: { tags, summary: 'Zuwendungsbestätigung als PDF', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const persons = ownPersons(u);
    const r = persons.length ? await db.selectFrom('donation_receipt').select(['number', 'pdf', 'status']).where('id', '=', req.params.id).where('organization_id', '=', u.organizationId).where('person_id', 'in', persons).executeTakeFirst() : undefined;
    if (!r) throw notFound('Zuwendungsbestätigung');
    // A cancelled receipt is no longer valid for the tax office; it stays listed but is not handed out.
    if (r.status !== 'issued') throw new Problem(410, 'cancelled', 'Diese Bestätigung wurde storniert.');
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${r.number}.pdf"`).header('cache-control', 'private, no-store').send(r.pdf);
  });

  // ---------- Changes and resignation ----------

  app.post(
    '/portal/change-requests',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Eigene Daten ändern: Telefon sofort, alles andere nach Prüfung durch den Verein', security: [], body: changeBody } },
    async (req, reply) => {
      const u = await portalUser(req, reply);
      const b = req.body;
      const m = ownMember(u, b.memberId);
      requireFeature(m, b.field === 'iban' ? 'bank' : 'profile');
      const invalid = (field: string, message: string) => new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field, message }] });
      let old: string | null;
      let value: string;
      if (b.field === 'address') {
        const problem = postalCodeProblem(b.postalCode, m.country);
        if (problem) throw invalid('postalCode', problem);
        old = m.street || m.postal_code || m.city ? JSON.stringify({ street: m.street, postalCode: m.postal_code, city: m.city }) : null;
        value = JSON.stringify({ street: b.street, postalCode: b.postalCode, city: b.city });
      } else if (b.field === 'iban') {
        const iban = normalizeIban(b.iban);
        if (!isValidIban(iban)) throw invalid('iban', 'Diese IBAN ist nicht gültig.');
        old = null;
        value = encrypt(JSON.stringify({ iban, accountHolder: b.accountHolder }));
      } else {
        if (b.field === 'email' && !emailSchema.safeParse(b.value).success) throw invalid('value', 'Bitte eine gültige E-Mail-Adresse angeben.');
        if (b.field !== 'phone' && !b.value) throw invalid('value', 'Bitte ausfüllen.');
        old = (m as Record<string, unknown>)[b.field] as string | null;
        value = b.value;
      }
      const field = b.field;
      const result = await db.transaction().execute(async (tx) => {
        if (IMMEDIATE.includes(field)) {
          await tx.updateTable('person').set({ [field]: value || null, updated_at: new Date() }).where('id', '=', m.personId).execute();
          await tx.insertInto('change_request').values({ organization_id: u.organizationId, member_id: m.memberId, person_id: m.personId, field, old_value: old, new_value: value, status: 'applied', requested_by_email: u.email, decided_at: new Date() }).execute();
          await audit(tx, u.organizationId, null, { action: 'portal.changed', entityType: 'member', entityId: m.memberId, diff: { [field]: [old, value] } });
          return 'applied' as const;
        }
        // A newer wish for the same field replaces the pending one.
        await tx.updateTable('change_request').set({ status: 'superseded', decided_at: new Date() }).where('member_id', '=', m.memberId).where('field', '=', field).where('status', '=', 'pending').execute();
        await tx.insertInto('change_request').values({ organization_id: u.organizationId, member_id: m.memberId, person_id: m.personId, field, old_value: old, new_value: value, requested_by_email: u.email }).execute();
        await audit(tx, u.organizationId, null, { action: 'portal.change_requested', entityType: 'member', entityId: m.memberId, diff: { field: [null, field] } });
        return 'pending' as const;
      });
      // E-mail and bank changes are announced to the address on file, so a hijacked session cannot change them silently.
      if (result === 'pending' && (field === 'email' || field === 'iban') && m.email) {
        await sendSystemMail(db, u.organizationId, 'change_decided', m.email, { vorname: m.first_name ?? '', entscheidung: `für Deine Mitgliedschaft wurde eine Änderung ${field === 'email' ? 'Deiner E-Mail-Adresse' : 'Deiner Bankverbindung'} beantragt. Der Verein prüft sie. Wenn Du das nicht warst, antworte bitte auf diese E-Mail.` });
      }
      return { status: result };
    },
  );

  app.post(
    '/portal/resignation',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Kündigung einreichen; der Verein bestätigt sie', security: [], body: z.object({ memberId: z.uuid() }) } },
    async (req, reply) => {
      const u = await portalUser(req, reply);
      const m = ownMember(u, req.body.memberId);
      requireFeature(m, 'resignation');
      if (m.status === 'resigned') throw new Problem(409, 'already-resigned', 'Diese Mitgliedschaft ist schon gekündigt.');
      // Someone with their own address resigns themselves; the payer only for members without one (e.g. children).
      if (m.viaHousehold && m.email) throw new Problem(403, 'own-access', 'Kündigen kann nur das Mitglied selbst.', `${m.first_name ?? 'Das Mitglied'} hat eine eigene E-Mail-Adresse und kann sich selbst im Portal anmelden.`);
      const org = await db.selectFrom('organization').select(['notice_weeks', 'exit_at']).where('id', '=', u.organizationId).executeTakeFirstOrThrow();
      const today = await orgToday(db, u.organizationId);
      const proposal = proposeExitDate(today, org.notice_weeks, org.exit_at);
      // A future member cannot leave before joining.
      const exit = m.join_date && m.join_date > proposal ? m.join_date : proposal;
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('change_request').set({ status: 'superseded', decided_at: new Date() }).where('member_id', '=', m.memberId).where('field', '=', 'resignation').where('status', '=', 'pending').execute();
        await tx.insertInto('change_request').values({ organization_id: u.organizationId, member_id: m.memberId, person_id: m.personId, field: 'resignation', old_value: today, new_value: exit, requested_by_email: u.email }).execute();
        await audit(tx, u.organizationId, null, { action: 'portal.resignation_requested', entityType: 'member', entityId: m.memberId, diff: { exitDate: [null, exit] } });
      });
      if (m.email) await sendSystemMail(db, u.organizationId, 'resignation_received', m.email, { vorname: m.first_name ?? '', austritt: formatDate(exit) });
      return { exitDate: exit };
    },
  );
};
