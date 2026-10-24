import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { ageOn, applicationDataOut, formInput, publicForm, submission, type ApplicationData } from '../../shared/applications.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { config } from '../config.ts';
import { blindIndex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { applicationPdf } from '../applications/pdf.ts';
import { sendSystemMail } from '../mail/system.ts';
import { orgToday } from '../members/query.ts';
import { requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';
import { insertMember } from './members.ts';
import { insertMandate } from './sepa.ts';

const tags = ['applications'];
const idParam = z.object({ id: z.uuid() });
const MIN_FILL_MS = 3_000;
const TOKEN_TTL_MS = 24 * 3_600_000;

// The form token carries the time the form was shown, signed, so bots that post instantly or replay old tokens stand out.
const sign = (slug: string, ts: number) => createHmac('sha256', config.dataKey).update(`form:${slug}:${ts}`).digest('base64url').slice(0, 32);
const formToken = (slug: string) => {
  const ts = Date.now();
  return `${ts}.${sign(slug, ts)}`;
};
function tokenAge(slug: string, token: string) {
  const [ts, mac] = token.split('.');
  const n = Number(ts);
  if (!mac || !Number.isFinite(n)) return null;
  const want = Buffer.from(sign(slug, n));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? Date.now() - n : null;
}

const addMonths = (date: string, n: number) => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
/** Join date for an accepted application by the club's rule. */
export function joinDateFor(rule: 'application_date' | 'acceptance_date' | 'month_first' | 'next_month_first', applied: string, today: string) {
  if (rule === 'application_date') return applied;
  if (rule === 'acceptance_date') return today;
  if (rule === 'month_first') return `${applied.slice(0, 7)}-01`;
  return addMonths(applied, 1);
}

const applicationDto = z.object({
  id: z.uuid(),
  formTitle: z.string(),
  status: z.enum(['new', 'accepted', 'rejected', 'spam']),
  data: applicationDataOut,
  consent: z.object({ text: z.string(), version: z.number(), acceptedAt: z.string() }),
  groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
  feePlan: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  minor: z.boolean(),
  duplicates: z.array(z.object({ memberId: z.uuid(), name: z.string(), number: z.string(), reason: z.string() })),
  memberId: z.uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});

export const applicationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function loadForm(slug: string) {
    const f = await db.selectFrom('application_form').selectAll().where('slug', '=', slug).where('active', '=', true).executeTakeFirst();
    if (!f) throw notFound('Formular');
    return f;
  }
  async function formChoices(organizationId: string, groupIds: string[], planIds: string[]) {
    const groups = groupIds.length ? await db.selectFrom('club_group').select(['id', 'name']).where('organization_id', '=', organizationId).where('id', 'in', groupIds).where('archived_at', 'is', null).orderBy('name').execute() : [];
    const today = await orgToday(db, organizationId);
    const plans = planIds.length
      ? await db
          .selectFrom('fee_plan')
          .innerJoin('fee_plan_version as v', 'v.fee_plan_id', 'fee_plan.id')
          .select(['fee_plan.id', 'fee_plan.name', 'v.amount_cents', 'v.interval_months', 'v.valid_from'])
          .where('fee_plan.organization_id', '=', organizationId)
          .where('fee_plan.id', 'in', planIds)
          .where('fee_plan.status', '=', 'active')
          .where('v.valid_from', '<=', today)
          .orderBy('fee_plan.name')
          .orderBy('v.valid_from', 'desc')
          .execute()
      : [];
    const seen = new Set<string>();
    const feePlans = plans.filter((p) => !seen.has(p.id) && seen.add(p.id)).map((p) => ({ id: p.id, name: p.name, amountCents: Number(p.amount_cents), interval: p.interval_months === 12 ? 'jährlich' : p.interval_months === 1 ? 'monatlich' : p.interval_months === 3 ? 'vierteljährlich' : p.interval_months === 6 ? 'halbjährlich' : p.interval_months ? `alle ${p.interval_months} Monate` : 'einmalig' }));
    return { groups, feePlans };
  }

  // ---------- Public ----------

  app.get('/public/forms/:slug', { schema: { tags, summary: 'Aufnahmeformular (öffentlich)', security: [], params: z.object({ slug: z.string().max(60) }), response: { 200: publicForm } } }, async (req) => {
    const f = await loadForm(req.params.slug);
    const org = await db.selectFrom('organization').select(['name', 'creditor_id']).where('id', '=', f.organization_id).executeTakeFirstOrThrow();
    const { groups, feePlans } = await formChoices(f.organization_id, f.group_ids, f.fee_plan_ids);
    return { title: f.title, intro: f.intro, clubName: org.name, groups, feePlans, askMandate: f.ask_mandate && !!org.creditor_id, creditorId: org.creditor_id, consentText: f.consent_text, privacyUrl: f.privacy_url, token: formToken(f.slug) };
  });

  app.post(
    '/public/forms/:slug/submit',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Aufnahmeantrag abschicken (öffentlich; Honeypot, Mindest-Ausfüllzeit, Rate-Limit)', security: [], params: z.object({ slug: z.string().max(60) }), body: submission, response: { 201: z.object({ ok: z.boolean() }) } } },
    async (req, reply) => {
      const f = await loadForm(req.params.slug);
      const { data } = req.body;
      const age = tokenAge(f.slug, req.body.token);
      const today = await orgToday(db, f.organization_id);
      // Bots get the same answer as people; their submission is kept as spam for the record but never shown as new.
      const spam = !!req.body.website || age === null || age < MIN_FILL_MS || age > TOKEN_TTL_MS;
      if (!spam) {
        const invalid = (field: string, message: string) => new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field, message }] });
        if (data.birthDate > today) throw invalid('data.birthDate', 'Das Geburtsdatum liegt in der Zukunft.');
        if (ageOn(data.birthDate, today) < 18 && !data.guardian) throw invalid('data.guardian', 'Für Minderjährige brauchen wir eine erziehungsberechtigte Person.');
        if (data.groupIds.some((g) => !f.group_ids.includes(g))) throw invalid('data.groupIds', 'Diese Gruppe gibt es im Formular nicht.');
        if (data.feePlanId && !f.fee_plan_ids.includes(data.feePlanId)) throw invalid('data.feePlanId', 'Diesen Beitrag gibt es im Formular nicht.');
        if (f.fee_plan_ids.length && !data.feePlanId) throw invalid('data.feePlanId', 'Bitte wähle einen Beitrag.');
        if (data.mandate && !f.ask_mandate) throw invalid('data.mandate', 'Dieses Formular nimmt keine Lastschrift an.');
        // A minor never signs a mandate: the account holder must be someone else.
        if (data.mandate && ageOn(data.birthDate, today) < 18 && data.mandate.accountHolder.trim().toLowerCase() === `${data.firstName} ${data.lastName}`.trim().toLowerCase()) {
          throw invalid('data.mandate.accountHolder', 'Bei Minderjährigen ist die erziehungsberechtigte Person Kontoinhaber:in.');
        }
      }
      const acceptedAt = new Date();
      const row = await db.transaction().execute(async (tx) => {
        const a = await tx
          .insertInto('application')
          .values({ organization_id: f.organization_id, form_id: f.id, payload: JSON.stringify(data), consent: JSON.stringify({ text: f.consent_text, version: f.consent_version, acceptedAt: acceptedAt.toISOString() }), ip_hash: blindIndex(`ip:${req.ip}:${today.slice(0, 7)}`), status: spam ? 'spam' : 'new' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await audit(tx, f.organization_id, null, { action: spam ? 'application.spam' : 'application.received', entityType: 'application', entityId: a.id });
        return a;
      });
      if (!spam) {
        const org = await db.selectFrom('organization').select(['name', 'creditor_id', 'electronic_mandates_agreed']).where('id', '=', f.organization_id).executeTakeFirstOrThrow();
        const { groups, feePlans } = await formChoices(f.organization_id, data.groupIds, data.feePlanId ? [data.feePlanId] : []);
        const pdf = await applicationPdf({ club: org.name, creditorId: org.creditor_id, submittedAt: acceptedAt, data, groups: groups.map((g) => g.name), feePlan: feePlans[0]?.name ?? null, consentText: f.consent_text, mandatePending: !!data.mandate && !org.electronic_mandates_agreed });
        const to = data.guardian?.email ?? data.email;
        await sendSystemMail(db, f.organization_id, 'application_received', to, { vorname: data.firstName }, [{ filename: 'Aufnahmeantrag.pdf', content: pdf, contentType: 'application/pdf' }]);
        void row;
      }
      reply.status(201);
      return { ok: true };
    },
  );

  // ---------- Board ----------

  const unscoped = (actor: Actor) => {
    requirePermission(actor, 'members', 'write');
    if (scopeOf(actor, 'members', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Aufnahmeanträge bearbeiten Zugänge für den ganzen Verein.', { permission: 'members:write (ganzer Verein)' });
  };
  const formDto = z.object({ id: z.uuid(), slug: z.string(), title: z.string(), intro: z.string().nullable(), groupIds: z.array(z.uuid()), feePlanIds: z.array(z.uuid()), askMandate: z.boolean(), consentText: z.string(), consentVersion: z.number(), privacyUrl: z.string().nullable(), allowedOrigins: z.array(z.string()), active: z.boolean(), url: z.string() });
  const toFormDto = (f: Awaited<ReturnType<typeof loadForm>>) => ({ id: f.id, slug: f.slug, title: f.title, intro: f.intro, groupIds: f.group_ids, feePlanIds: f.fee_plan_ids, askMandate: f.ask_mandate, consentText: f.consent_text, consentVersion: f.consent_version, privacyUrl: f.privacy_url, allowedOrigins: f.allowed_origins, active: f.active, url: `${config.publicUrl}/aufnahme/${f.slug}` });

  app.get('/application-forms', { schema: { tags, summary: 'Aufnahmeformulare', response: { 200: z.array(formDto) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    return (await db.selectFrom('application_form').selectAll().where('organization_id', '=', actor.organizationId).orderBy('created_at').execute()).map(toFormDto);
  });

  app.post('/application-forms', { schema: { tags, summary: 'Aufnahmeformular anlegen', body: formInput, response: { 201: formDto } } }, async (req, reply) => {
    const actor = requireActor(req);
    unscoped(actor);
    const b = req.body;
    const f = await db.transaction().execute(async (tx) => {
      const f = await tx.insertInto('application_form').values({ organization_id: actor.organizationId, slug: b.slug, title: b.title, intro: b.intro ?? null, group_ids: b.groupIds, fee_plan_ids: b.feePlanIds, ask_mandate: b.askMandate, consent_text: b.consentText, privacy_url: b.privacyUrl ?? null, allowed_origins: b.allowedOrigins, active: b.active }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'application_form.created', entityType: 'application_form', entityId: f.id, diff: { slug: [null, f.slug] } });
      return f;
    });
    reply.status(201);
    return toFormDto(f);
  });

  app.put('/application-forms/:id', { schema: { tags, summary: 'Aufnahmeformular ändern (ein neuer Einwilligungstext bekommt eine neue Version)', params: idParam, body: formInput, response: { 200: formDto } } }, async (req) => {
    const actor = requireActor(req);
    unscoped(actor);
    const b = req.body;
    const f = await db.transaction().execute(async (tx) => {
      const old = await tx.selectFrom('application_form').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!old) throw notFound('Formular');
      const f = await tx
        .updateTable('application_form')
        .set({ slug: b.slug, title: b.title, intro: b.intro ?? null, group_ids: b.groupIds, fee_plan_ids: b.feePlanIds, ask_mandate: b.askMandate, consent_text: b.consentText, consent_version: old.consent_text === b.consentText ? old.consent_version : old.consent_version + 1, privacy_url: b.privacyUrl ?? null, allowed_origins: b.allowedOrigins, active: b.active, updated_at: new Date() })
        .where('id', '=', old.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'application_form.updated', entityType: 'application_form', entityId: f.id, diff: { consentVersion: [old.consent_version, f.consent_version], active: [old.active, f.active] } });
      return f;
    });
    return toFormDto(f);
  });

  async function dto(actor: Actor, rows: { id: string; form_id: string; payload: unknown; consent: unknown; status: 'new' | 'accepted' | 'rejected' | 'spam'; member_id: string | null; reason: string | null; created_at: Date }[]) {
    const forms = await db.selectFrom('application_form').select(['id', 'title']).where('organization_id', '=', actor.organizationId).execute();
    const groups = await db.selectFrom('club_group').select(['id', 'name']).where('organization_id', '=', actor.organizationId).execute();
    const plans = await db.selectFrom('fee_plan').select(['id', 'name']).where('organization_id', '=', actor.organizationId).execute();
    const out = [];
    for (const r of rows) {
      const data = r.payload as ApplicationData;
      const dupes = await db
        .selectFrom('member')
        .innerJoin('person', 'person.id', 'member.person_id')
        .select(['member.id', 'member.membership_number', 'person.first_name', 'person.last_name', 'person.email', 'person.birth_date'])
        .where('member.organization_id', '=', actor.organizationId)
        .where((eb) => eb.or([eb(sql`lower(person.email)`, '=', data.email.toLowerCase()).and('person.first_name', 'ilike', data.firstName), eb('person.last_name', 'ilike', data.lastName).and('person.birth_date', '=', data.birthDate)]))
        .limit(5)
        .execute();
      // Bank details only for roles that may see IBANs.
      const shown = data.mandate && restrictedFields(actor).has('iban') ? { ...data, mandate: { ...data.mandate, iban: `•••• ${data.mandate.iban.slice(-4)}` } } : data;
      out.push({
        id: r.id,
        formTitle: forms.find((f) => f.id === r.form_id)?.title ?? '',
        status: r.status,
        data: shown,
        consent: r.consent as { text: string; version: number; acceptedAt: string },
        groups: data.groupIds.map((g) => ({ id: g, name: groups.find((x) => x.id === g)?.name ?? 'gelöschte Gruppe' })),
        feePlan: data.feePlanId ? { id: data.feePlanId, name: plans.find((p) => p.id === data.feePlanId)?.name ?? 'gelöschter Beitrag' } : null,
        minor: ageOn(data.birthDate, r.created_at.toISOString().slice(0, 10)) < 18,
        duplicates: dupes.map((d) => ({ memberId: d.id, name: `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim(), number: d.membership_number, reason: d.birth_date === data.birthDate ? 'gleicher Name und Geburtstag' : 'gleiche E-Mail-Adresse' })),
        memberId: r.member_id,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
      });
    }
    return out;
  }

  app.get('/applications', { schema: { tags, summary: 'Aufnahmeanträge', querystring: z.object({ status: z.enum(['new', 'accepted', 'rejected', 'spam']).default('new') }), response: { 200: z.array(applicationDto) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    if (scopeOf(actor, 'members', 'read') !== null) return [];
    const rows = await db.selectFrom('application').selectAll().where('organization_id', '=', actor.organizationId).where('status', '=', req.query.status).orderBy('created_at', 'desc').limit(200).execute();
    return dto(actor, rows);
  });

  async function loadNew(tx: Db, actor: Actor, id: string) {
    const a = await tx.selectFrom('application').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
    if (!a) throw notFound('Antrag');
    if (a.status !== 'new') throw new Problem(409, 'decided', 'Über diesen Antrag ist schon entschieden.');
    return a;
  }

  app.post(
    '/applications/:id/accept',
    {
      schema: {
        tags,
        summary: 'Antrag annehmen: Person, Mitgliedschaft, Gruppen, Beitrag und Mandat in einem Schritt',
        params: idParam,
        body: z.object({ joinDate: z.iso.date().optional(), groupIds: z.array(z.uuid()).optional(), feePlanId: z.uuid().nullish(), ignoreDuplicates: z.boolean().default(false) }).optional(),
        response: { 200: z.object({ memberId: z.uuid(), mandateStatus: z.enum(['active', 'pending_evidence']).nullable() }) },
      },
    },
    async (req) => {
      const actor = requireActor(req);
      unscoped(actor);
      const today = await orgToday(db, actor.organizationId);
      const org = await db.selectFrom('organization').select(['join_rule', 'electronic_mandates_agreed']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
      const result = await db.transaction().execute(async (tx) => {
        const a = await loadNew(tx, actor, req.params.id);
        const data = a.payload as ApplicationData;
        if (!req.body?.ignoreDuplicates) {
          const [d] = await dto(actor, [a]);
          if (d!.duplicates.length) throw new Problem(409, 'duplicate', 'Diese Person ist vielleicht schon Mitglied.', `Mögliche Treffer: ${d!.duplicates.map((x) => `${x.name} (${x.number}, ${x.reason})`).join('; ')}. Prüfe sie und nimm den Antrag dann ausdrücklich an.`);
        }
        const joinDate = req.body?.joinDate ?? joinDateFor(org.join_rule, a.created_at.toISOString().slice(0, 10), today);
        const memberId = await insertMember(
          tx,
          actor,
          { kind: 'natural', firstName: data.firstName, lastName: data.lastName, birthDate: data.birthDate, email: data.guardian?.email ?? data.email, phone: data.phone ?? data.guardian?.phone ?? null, street: data.street, postalCode: data.postalCode, city: data.city, country: 'DE', preferredChannel: 'email', note: data.guardian ? `Erziehungsberechtigt: ${data.guardian.name}${data.note ? `\n${data.note}` : ''}` : (data.note ?? null), joinDate, applicationDate: a.created_at.toISOString().slice(0, 10), groupIds: req.body?.groupIds ?? data.groupIds, companyName: null },
          today,
          'member.created_from_application',
        );
        const member = await tx.selectFrom('member').select(['person_id', 'membership_number']).where('id', '=', memberId).executeTakeFirstOrThrow();
        const planId = req.body?.feePlanId !== undefined ? req.body.feePlanId : data.feePlanId;
        if (planId) {
          await tx.insertInto('fee_assignment').values({ organization_id: actor.organizationId, member_id: memberId, fee_plan_id: planId, is_main: true, valid_from: joinDate }).execute();
          await audit(tx, actor.organizationId, actor, { action: 'member.fee_assigned', entityType: 'member', entityId: memberId, diff: { plan: [null, planId], validFrom: [null, joinDate] } });
        }
        let mandateStatus: 'active' | 'pending_evidence' | null = null;
        if (data.mandate) {
          // Without the bank's written agreement to online mandates, the mandate waits for a signature.
          const pending = !org.electronic_mandates_agreed;
          await insertMandate(tx, actor, { personId: member.person_id, memberId, membershipNumber: member.membership_number, today, signedOn: a.created_at.toISOString().slice(0, 10), accountHolder: data.mandate.accountHolder, iban: data.mandate.iban, type: 'recurrent', pendingEvidence: pending });
          await tx.updateTable('member').set({ payment_method: 'direct_debit' }).where('id', '=', memberId).execute();
          mandateStatus = pending ? 'pending_evidence' : 'active';
        }
        await tx.updateTable('application').set({ status: 'accepted', member_id: memberId, decided_by: actor.userId, decided_at: new Date() }).where('id', '=', a.id).execute();
        await audit(tx, actor.organizationId, actor, { action: 'application.accepted', entityType: 'application', entityId: a.id, diff: { member: [null, memberId] } });
        return { memberId, mandateStatus, data, number: member.membership_number };
      });
      const extra = result.mandateStatus === 'pending_evidence' ? '\n\nBitte unterschreib das SEPA-Mandat aus Deiner Antragskopie und gib es beim Verein ab. Bis dahin ziehen wir nichts ein.' : '';
      await sendSystemMail(db, actor.organizationId, 'application_accepted', result.data.guardian?.email ?? result.data.email, { vorname: result.data.firstName, mitgliedsnummer: result.number, entscheidung: extra });
      return { memberId: result.memberId, mandateStatus: result.mandateStatus };
    },
  );

  app.post(
    '/applications/decide',
    { schema: { tags, summary: 'Anträge ablehnen oder als Spam markieren (einzeln oder mehrere)', body: z.object({ ids: z.array(z.uuid()).min(1).max(200), action: z.enum(['reject', 'spam']), reason: z.string().trim().max(500).optional() }), response: { 200: z.object({ decided: z.number() }) } } },
    async (req) => {
      const actor = requireActor(req);
      unscoped(actor);
      const { ids, action, reason } = req.body;
      if (action === 'reject' && (!reason || reason.length < 3)) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'reason', message: 'Bitte gib eine Begründung für die Absage an.' }] });
      const decided = await db.transaction().execute(async (tx) => {
        const out: ApplicationData[] = [];
        for (const id of ids) {
          const a = await loadNew(tx, actor, id);
          await tx.updateTable('application').set({ status: action === 'reject' ? 'rejected' : 'spam', reason: reason ?? null, decided_by: actor.userId, decided_at: new Date() }).where('id', '=', a.id).execute();
          await audit(tx, actor.organizationId, actor, { action: action === 'reject' ? 'application.rejected' : 'application.marked_spam', entityType: 'application', entityId: a.id });
          if (action === 'reject') out.push(a.payload as ApplicationData);
        }
        return out;
      });
      for (const d of decided) await sendSystemMail(db, actor.organizationId, 'application_rejected', d.guardian?.email ?? d.email, { vorname: d.firstName, entscheidung: reason ?? '' });
      return { decided: ids.length };
    },
  );
};
