import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { correction, generate } from 'lean-qr';
import { toSvgSource } from 'lean-qr/extras/svg';
import { sql } from 'kysely';
import { z } from 'zod';
import { email as emailSchema } from '../../shared/auth.ts';
import { formatDate, proposeExitDate } from '../../shared/dates.ts';
import { isValidIban, normalizeIban } from '../../shared/iban.ts';
import { audit } from '../audit.ts';
import { sha256 } from '../auth/session.ts';
import { config } from '../config.ts';
import { blindIndex, encrypt } from '../crypto.ts';
import type { ChangeField, Db } from '../db.ts';
import { getBlob } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { epcPayload } from '../invoices/pdf.ts';
import { storedPdf, type IssueSnapshot } from '../invoices/service.ts';
import { sendSystemMail } from '../mail/system.ts';
import { orgToday } from '../members/query.ts';

export const PORTAL_COOKIE = 'ov_portal';
const PORTAL_IDLE_MS = 30 * 24 * 60 * 60 * 1000; // members stay signed in on their phone for 30 days of use
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const tags = ['portal'];

const emailKey = (e: string) => blindIndex(`login:${e.trim().toLowerCase()}`);
const codeHash = (codeId: string, code: string) => sha256(`${codeId}:${code}`);
const CURRENT = ['active', 'future', 'resigned'] as const;

/** Fields members may change themselves; phone applies at once, the rest waits for an admin. */
export const IMMEDIATE: ChangeField[] = ['phone'];
const changeField = z.enum(['first_name', 'last_name', 'email', 'phone', 'street', 'postal_code', 'city', 'iban']);

/** Issues a 6-digit code for an address. Returns the code; only its hash is stored. */
export async function issueLoginCode(db: Db, organizationId: string, email: string, issuedBy: string | null) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const row = await db.insertInto('login_code').values({ organization_id: organizationId, email_hash: emailKey(email), code_hash: 'pending', expires_at: new Date(Date.now() + (issuedBy ? 24 * 60 : 10) * 60_000), issued_by: issuedBy }).returning('id').executeTakeFirstOrThrow();
  await db.updateTable('login_code').set({ code_hash: codeHash(row.id, code) }).where('id', '=', row.id).execute();
  return code;
}

export const portalRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** The signed-in address and every current membership registered under it. */
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
      .select(['member.id as memberId', 'member.person_id as personId', 'member.status', 'member.membership_number', 'member.join_date', 'member.exit_date', 'member.notice_date', 'person.first_name', 'person.last_name', 'person.company_name', 'person.kind', 'person.email', 'person.phone', 'person.street', 'person.postal_code', 'person.city'])
      .where('member.organization_id', '=', s.organization_id)
      .where(sql<boolean>`lower(person.email) = lower(${s.email})`)
      .where('member.status', 'in', [...CURRENT])
      .orderBy('person.first_name')
      .execute();
    return { session: s, organizationId: s.organization_id, email: s.email, members };
  }
  type PortalUser = Awaited<ReturnType<typeof portalUser>>;
  const ownMember = (u: PortalUser, memberId: string) => {
    const m = u.members.find((x) => x.memberId === memberId);
    if (!m) throw notFound('Mitgliedschaft');
    return m;
  };

  // ---------- Sign-in ----------

  app.post(
    '/portal/auth/request-code',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Anmeldecode per E-Mail anfordern (antwortet immer gleich, damit niemand Adressen ausprobieren kann)', security: [], body: z.object({ email: emailSchema }) } },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      const org = await db.selectFrom('organization').select('id').executeTakeFirst();
      if (!org) return { ok: true };
      const member = await db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').select('member.id').where('member.organization_id', '=', org.id).where(sql<boolean>`lower(person.email) = ${email}`).where('member.status', 'in', [...CURRENT]).executeTakeFirst();
      // At most three codes per address and hour, so the endpoint cannot be used to flood an inbox.
      const recent = await db.selectFrom('login_code').select(sql<number>`count(*)::int`.as('n')).where('email_hash', '=', emailKey(email)).where('created_at', '>', new Date(Date.now() - 3_600_000)).executeTakeFirstOrThrow();
      if (member && recent.n < 3) {
        const code = await issueLoginCode(db, org.id, email, null);
        await sendSystemMail(db, org.id, 'login_code', email, { code, link: `${config.publicUrl}/portal/anmelden#${new URLSearchParams({ email, code })}` });
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
      const token = await db.transaction().execute(async (tx) => {
        const c = await tx.selectFrom('login_code').selectAll().where('email_hash', '=', emailKey(email)).where('consumed_at', 'is', null).where('expires_at', '>', new Date()).where('attempts', '<', MAX_ATTEMPTS).orderBy('created_at', 'desc').limit(1).forUpdate().executeTakeFirst();
        if (!c) throw wrong();
        const ok = timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(codeHash(c.id, req.body.code)));
        if (!ok) {
          await tx.updateTable('login_code').set({ attempts: c.attempts + 1 }).where('id', '=', c.id).execute();
          return null;
        }
        await tx.updateTable('login_code').set({ consumed_at: new Date() }).where('id', '=', c.id).execute();
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
    const org = await db.selectFrom('organization').select(['name', 'email', 'notice_weeks', 'exit_at']).where('id', '=', u.organizationId).executeTakeFirstOrThrow();
    const today = await orgToday(db, u.organizationId);
    const ids = u.members.map((m) => m.memberId);
    const groups = ids.length
      ? await db.selectFrom('group_membership').innerJoin('club_group', 'club_group.id', 'group_membership.group_id').select(['group_membership.member_id', 'club_group.name', 'club_group.color']).where('group_membership.member_id', 'in', ids).where('group_membership.valid_from', '<=', today).where((eb) => eb.or([eb('group_membership.valid_to', 'is', null), eb('group_membership.valid_to', '>=', today)])).where('club_group.archived_at', 'is', null).execute()
      : [];
    const mandates = ids.length ? await db.selectFrom('sepa_mandate').select(['person_id', 'reference', 'iban_last4', 'signed_on', 'status']).where('person_id', 'in', u.members.map((m) => m.personId)).where('status', 'in', ['active', 'pending_evidence']).execute() : [];
    const pending = ids.length ? await db.selectFrom('change_request').select(['member_id', 'field', 'new_value', 'requested_at']).where('member_id', 'in', ids).where('status', '=', 'pending').execute() : [];
    return {
      email: u.email,
      club: { name: org.name, email: org.email },
      members: u.members.map((m) => ({
        memberId: m.memberId,
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
        mandate: mandates.filter((x) => x.person_id === m.personId).map((x) => ({ reference: x.reference, ibanLast4: x.iban_last4, signedOn: x.signed_on, status: x.status }))[0] ?? null,
        pending: pending.filter((p) => p.member_id === m.memberId).map((p) => ({ field: p.field, value: p.field === 'iban' ? `•••• ${'xxxx'}` : p.new_value, requestedAt: p.requested_at.toISOString() })),
        resignationProposal: m.status === 'resigned' ? null : proposeExitDate(today, org.notice_weeks, org.exit_at),
      })),
    };
  });

  /** Invoices addressed to any person under this address. */
  async function ownInvoices(u: PortalUser) {
    const persons = u.members.map((m) => m.personId);
    if (!persons.length) return [];
    return db.selectFrom('invoice').selectAll().where('organization_id', '=', u.organizationId).where('recipient_person_id', 'in', persons).where('status', '!=', 'draft').orderBy('issue_date', 'desc').execute();
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

  app.get('/portal/invoices/:id/qr.svg', { schema: { tags, summary: 'GiroCode zum Bezahlen per Banking-App (nur offene Rechnungen)', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const { inv } = await ownInvoice(req, reply);
    const snap = inv.recipient as IssueSnapshot | null;
    const open = inv.total_cents - inv.paid_cents;
    if (!['open', 'partially_paid'].includes(inv.status) || !snap?.org.iban || open <= 0) throw notFound('Zahlcode');
    const code = generate(epcPayload({ name: snap.org.name, iban: snap.org.iban, bic: snap.org.bic, amountCents: open, remittance: inv.number ?? '' }), { minCorrectionLevel: correction.M });
    return reply.header('content-type', 'image/svg+xml').header('cache-control', 'private, no-store').send(toSvgSource(code, { on: '#14202e', off: '#ffffff', padX: 4, padY: 4 }));
  });

  app.get('/portal/documents', { schema: { tags, summary: 'Dokumente, die der Verein mit Mitgliedern teilt', security: [] } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    if (!u.members.length) return [];
    const rows = await db.selectFrom('file').innerJoin('folder', 'folder.id', 'file.folder_id').select(['file.id', 'file.name', 'file.size_bytes', 'file.mime_type', 'file.created_at', 'folder.name as folder']).where('file.organization_id', '=', u.organizationId).where('folder.share_with_members', '=', true).where('file.superseded_at', 'is', null).orderBy('folder.name').orderBy('file.name').execute();
    return rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder, sizeBytes: Number(r.size_bytes), mimeType: r.mime_type, createdAt: r.created_at.toISOString() }));
  });

  app.get('/portal/documents/:id', { schema: { tags, summary: 'Geteiltes Dokument herunterladen', security: [], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const u = await portalUser(req, reply);
    const f = u.members.length ? await db.selectFrom('file').innerJoin('folder', 'folder.id', 'file.folder_id').select(['file.sha256', 'file.name', 'file.mime_type']).where('file.id', '=', req.params.id).where('file.organization_id', '=', u.organizationId).where('folder.share_with_members', '=', true).executeTakeFirst() : undefined;
    if (!f) throw notFound('Dokument');
    const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(f.mime_type);
    return reply
      .header('content-type', inline ? f.mime_type : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(await getBlob(f.sha256));
  });

  // ---------- Changes and resignation ----------

  app.post(
    '/portal/change-requests',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Eigene Daten ändern: Telefon sofort, alles andere nach Prüfung durch den Verein', security: [], body: z.object({ memberId: z.uuid(), field: changeField, value: z.string().trim().max(200) }) } },
    async (req, reply) => {
      const u = await portalUser(req, reply);
      const m = ownMember(u, req.body.memberId);
      const { field } = req.body;
      let value = req.body.value;
      const invalid = (message: string) => new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'value', message }] });
      if (field === 'email' && !emailSchema.safeParse(value).success) throw invalid('Bitte eine gültige E-Mail-Adresse angeben.');
      if (field === 'postal_code' && !/^\d{5}$/.test(value)) throw invalid('Die Postleitzahl hat fünf Ziffern.');
      if (['first_name', 'last_name', 'street', 'city'].includes(field) && !value) throw invalid('Bitte ausfüllen.');
      if (field === 'iban') {
        value = normalizeIban(value);
        if (!isValidIban(value)) throw invalid('Diese IBAN ist nicht gültig.');
      }
      const old = field === 'iban' ? null : ((m as Record<string, unknown>)[field] as string | null);
      const result = await db.transaction().execute(async (tx) => {
        if (IMMEDIATE.includes(field)) {
          await tx.updateTable('person').set({ [field]: value || null }).where('id', '=', m.personId).execute();
          await tx.insertInto('change_request').values({ organization_id: u.organizationId, member_id: m.memberId, person_id: m.personId, field, old_value: old, new_value: value, status: 'applied', requested_by_email: u.email, decided_at: new Date() }).execute();
          await audit(tx, u.organizationId, null, { action: 'portal.changed', entityType: 'member', entityId: m.memberId, diff: { [field]: [old, value] } });
          return 'applied' as const;
        }
        // A newer wish for the same field replaces the pending one.
        await tx.updateTable('change_request').set({ status: 'superseded', decided_at: new Date() }).where('member_id', '=', m.memberId).where('field', '=', field).where('status', '=', 'pending').execute();
        await tx.insertInto('change_request').values({ organization_id: u.organizationId, member_id: m.memberId, person_id: m.personId, field, old_value: old, new_value: field === 'iban' ? encrypt(value) : value, requested_by_email: u.email }).execute();
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
      if (m.status === 'resigned') throw new Problem(409, 'already-resigned', 'Diese Mitgliedschaft ist schon gekündigt.');
      const org = await db.selectFrom('organization').select(['notice_weeks', 'exit_at']).where('id', '=', u.organizationId).executeTakeFirstOrThrow();
      const today = await orgToday(db, u.organizationId);
      const exit = proposeExitDate(today, org.notice_weeks, org.exit_at);
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
