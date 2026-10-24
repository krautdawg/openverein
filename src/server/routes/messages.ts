import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { resolveTxt } from 'node:dns/promises';
import { fill, SYSTEM_TEMPLATES, type SystemTemplateKey } from '../../shared/mail.ts';
import { displayName } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { deliveryFromToken, emailHash } from '../mail/worker.ts';
import { mailer, senderOf } from '../mail/transport.ts';
import { applyScope, orgToday, scopePredicate } from '../members/query.ts';
import { requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';

const tags = ['communication'];
const idParam = z.object({ id: z.uuid() });

const filter = z.object({
  /** all current members, one group, or hand-picked members */
  mode: z.enum(['all', 'group', 'members']),
  groupId: z.uuid().optional(),
  memberIds: z.array(z.uuid()).max(5000).optional(),
});
const recipient = z.object({ memberId: z.uuid(), personId: z.uuid(), name: z.string(), email: z.string() });
const excluded = z.object({ memberId: z.uuid(), name: z.string(), reason: z.string() });
const recipientsResult = z.object({ recipients: z.array(recipient), excluded: z.array(excluded) });

const messageInput = z.object({
  subject: z.string().trim().min(1, 'Bitte einen Betreff angeben.').max(200),
  body: z.string().trim().min(1, 'Bitte einen Text schreiben.').max(50_000),
  category: z.enum(['notice', 'newsletter']).default('notice'),
  filter,
});

const messageDto = z.object({
  id: z.uuid(),
  kind: z.enum(['free', 'invoices']),
  category: z.enum(['notice', 'newsletter']),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['sending', 'sent']),
  createdBy: z.string(),
  createdAt: z.string(),
  counts: z.object({ total: z.number(), sent: z.number(), queued: z.number(), failed: z.number() }),
});
const deliveryDto = z.object({ id: z.uuid(), memberId: z.uuid().nullable(), name: z.string(), email: z.string(), status: z.enum(['queued', 'sending', 'sent', 'failed', 'bounced', 'skipped']), error: z.string().nullable(), sentAt: z.string().nullable(), invoiceNumber: z.string().nullable() });

/** Plain-language hints about the sender domain's SPF and DMARC records (DKIM needs the provider's selector, so only a reminder). */
async function dnsHints(address: string) {
  const domain = address.split('@')[1];
  if (!domain) return [];
  const txt = async (name: string) => (await resolveTxt(name).catch(() => [] as string[][])).map((r) => r.join(''));
  const hints: string[] = [];
  const spf = (await txt(domain)).find((r) => r.startsWith('v=spf1'));
  hints.push(spf ? `SPF für ${domain} ist eingerichtet (${spf.slice(0, 80)}). Prüfe, dass Dein Mailserver darin vorkommt.` : `Für ${domain} gibt es keinen SPF-Eintrag. Ohne ihn landen Vereinsmails oft im Spam.`);
  const dmarc = (await txt(`_dmarc.${domain}`)).find((r) => r.startsWith('v=DMARC1'));
  hints.push(dmarc ? `DMARC für ${domain} ist eingerichtet.` : `Für ${domain} gibt es keinen DMARC-Eintrag (_dmarc.${domain}). Große Postfächer verlangen ihn inzwischen.`);
  hints.push('DKIM-Signaturen richtet Dein Mailanbieter ein; frag dort nach, ob sie für diese Absenderadresse aktiv sind.');
  return hints;
}

const TEMPLATE_KEYS = Object.keys(SYSTEM_TEMPLATES) as [SystemTemplateKey, ...SystemTemplateKey[]];

export const messageRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** Recipients with their e-mail, and everyone left out with the reason. Former members never get mail. */
  async function resolve(actor: Actor, f: z.infer<typeof filter>, category: 'notice' | 'newsletter') {
    if (restrictedFields(actor).has('email')) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Du darfst keine E-Mail-Adressen sehen.', { permission: 'members.field.email' });
    const today = await orgToday(db, actor.organizationId);
    let q = db
      .selectFrom('member')
      .innerJoin('person', 'person.id', 'member.person_id')
      .select(['member.id', 'member.person_id', 'member.status', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.email', 'person.preferred_channel'])
      .where('member.organization_id', '=', actor.organizationId)
      // Sending reaches only members the actor may write to (current group members, not last year's).
      .where(applyScope(actor, today, 'write', 'communication'));
    if (f.mode === 'group') {
      if (!f.groupId) throw new Problem(400, 'validation', 'Bitte eine Gruppe wählen.');
      q = q.where(scopePredicate([f.groupId], today, 'write'));
    }
    if (f.mode === 'members') q = q.where('member.id', 'in', f.memberIds?.length ? f.memberIds : ['00000000-0000-0000-0000-000000000000']);
    const rows = await q.orderBy('person.last_name').orderBy('person.first_name').execute();
    // Unsubscribing stops newsletters; club notices (invitations, invoices) stop only for undeliverable addresses.
    let sq = db.selectFrom('suppression').select('email_hash').where('organization_id', '=', actor.organizationId);
    if (category === 'notice') sq = sq.where('reason', 'in', ['bounce', 'manual']);
    const suppressed = new Set((await sq.execute()).map((s) => s.email_hash));
    const recipients: z.infer<typeof recipient>[] = [];
    const out: z.infer<typeof excluded>[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const name = displayName({ kind: r.kind, firstName: r.first_name, lastName: r.last_name, companyName: r.company_name });
      const reason =
        !['active', 'future', 'resigned'].includes(r.status) ? 'kein aktuelles Mitglied'
        : !r.email ? 'keine E-Mail-Adresse'
        : category === 'newsletter' && r.preferred_channel === 'none' ? 'möchte keine Post'
        : suppressed.has(emailHash(r.email)) ? 'Adresse gesperrt (abgemeldet oder unzustellbar)'
        : seen.has(r.email.toLowerCase()) ? 'gleiche Adresse wie ein anderes Mitglied'
        : null;
      if (reason) out.push({ memberId: r.id, name, reason });
      else {
        seen.add(r.email!.toLowerCase());
        recipients.push({ memberId: r.id, personId: r.person_id, name, email: r.email! });
      }
    }
    return { recipients, excluded: out };
  }

  app.post('/messages/recipients', { schema: { tags, summary: 'Empfänger:innen ermitteln (mit Ausschlüssen und Gründen)', body: z.object({ filter, category: z.enum(['notice', 'newsletter']).default('notice') }), response: { 200: recipientsResult } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    return resolve(actor, req.body.filter, req.body.category);
  });

  app.post('/messages/preview', { schema: { tags, summary: 'Betreff und Text für ein Mitglied einsetzen', body: z.object({ subject: z.string().max(200), body: z.string().max(50_000), memberId: z.uuid() }), response: { 200: z.object({ subject: z.string(), body: z.string() }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    const today = await orgToday(db, actor.organizationId);
    const m = await db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').innerJoin('organization', 'organization.id', 'member.organization_id')
      .select(['person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'member.membership_number', 'organization.name as org'])
      .where('member.id', '=', req.body.memberId).where('member.organization_id', '=', actor.organizationId).where(applyScope(actor, today, 'read', 'communication')).executeTakeFirst();
    if (!m) throw notFound('Mitglied');
    const values = { vorname: m.first_name ?? m.company_name ?? '', nachname: m.last_name ?? '', name: m.kind === 'organisation' ? (m.company_name ?? '') : [m.first_name, m.last_name].filter(Boolean).join(' '), mitgliedsnummer: m.membership_number, verein: m.org, rechnungsnummer: 'R-0000-00000', betrag: '0,00 €' };
    return { subject: fill(req.body.subject, values), body: fill(req.body.body, values) };
  });

  async function createMessage(tx: Db, actor: Actor, v: { kind: 'free' | 'invoices'; category: 'notice' | 'newsletter'; subject: string; body: string; filter: unknown }, recipients: { personId: string; memberId: string | null; email: string; invoiceId?: string }[]) {
    const m = await tx
      .insertInto('message')
      .values({ organization_id: actor.organizationId, kind: v.kind, category: v.category, subject: v.subject, body: v.body, recipient_filter: JSON.stringify(v.filter), created_by: actor.userId, created_by_label: actor.kind === 'token' ? `API: ${actor.name}` : actor.name })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const r of recipients) {
      await tx.insertInto('delivery').values({ organization_id: actor.organizationId, message_id: m.id, person_id: r.personId, member_id: r.memberId, email: r.email, invoice_id: r.invoiceId ?? null }).execute();
    }
    // Audit the action and the count, not the addresses.
    await audit(tx, actor.organizationId, actor, { action: 'message.sent', entityType: 'message', entityId: m.id, diff: { subject: [null, v.subject], recipients: [null, recipients.length], category: [null, v.category] } });
    return m.id;
  }

  app.post('/messages', { schema: { tags, summary: 'E-Mail an die Empfänger:innen senden (über die Warteschlange)', body: messageInput, response: { 201: messageDto } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    const { recipients } = await resolve(actor, req.body.filter, req.body.category);
    if (recipients.length === 0) throw new Problem(400, 'no-recipients', 'Niemand würde diese E-Mail bekommen.', 'Prüfe die Auswahl und die ausgeschlossenen Mitglieder.');
    const id = await db.transaction().execute((tx) => createMessage(tx, actor, { kind: 'free', ...req.body }, recipients.map((r) => ({ personId: r.personId, memberId: r.memberId, email: r.email }))));
    reply.status(201);
    return dto(actor, id);
  });

  app.post(
    '/invoices/send-mail',
    {
      schema: {
        tags,
        summary: 'Rechnungen per E-Mail mit PDF verschicken; wer Briefe bevorzugt oder keine Adresse hat, wird zum Ausdrucken gelistet',
        body: z.object({
          invoiceIds: z.array(z.uuid()).max(5000).optional(),
          feeRunId: z.uuid().optional(),
          template: z.enum(['invoice', 'dunning']).default('invoice'),
          subject: z.string().trim().min(1).max(200).optional(),
          body: z.string().trim().min(1).max(20_000).optional(),
          /** Without it, invoices that already went out by e-mail with this text are left out. */
          resend: z.boolean().default(false),
        }),
        response: { 201: z.object({ messages: z.array(messageDto), sent: z.number(), alreadySent: z.number(), toPrint: z.array(z.object({ invoiceId: z.uuid(), number: z.string(), name: z.string(), reason: z.string() })) }) },
      },
    },
    async (req, reply) => {
      const actor = requireActor(req);
      requirePermission(actor, 'communication', 'write');
      requirePermission(actor, 'invoices', 'read');
      if (scopeOf(actor, 'invoices', 'read') !== null || scopeOf(actor, 'communication', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', undefined, { permission: 'invoices:read (ganzer Verein)' });
      if (!req.body.invoiceIds?.length && !req.body.feeRunId) throw new Problem(400, 'validation', 'Bitte Rechnungen oder einen Beitragslauf angeben.');
      const text = await templateFor(actor.organizationId, req.body.template);
      let q = db
        .selectFrom('invoice')
        .innerJoin('person', 'person.id', 'invoice.recipient_person_id')
        .select(['invoice.id', 'invoice.number', 'invoice.member_id', 'invoice.status', 'invoice.recipient_person_id', 'person.email', 'person.preferred_channel', 'invoice.recipient'])
        .where('invoice.organization_id', '=', actor.organizationId)
        .where('invoice.kind', '!=', 'cancellation');
      q = req.body.feeRunId ? q.where('invoice.fee_run_id', '=', req.body.feeRunId) : q.where('invoice.id', 'in', req.body.invoiceIds!);
      // Dunning mails only make sense for invoices that are still open.
      if (req.body.template === 'dunning') q = q.where('invoice.status', 'in', ['open', 'partially_paid']);
      const rows = await q.orderBy('invoice.number').execute();
      const suppressed = new Set((await db.selectFrom('suppression').select('email_hash').where('organization_id', '=', actor.organizationId).where('reason', 'in', ['bounce', 'manual']).execute()).map((s) => s.email_hash));
      const mailed = new Set(
        req.body.resend || !rows.length
          ? []
          : (await db.selectFrom('delivery').innerJoin('message', 'message.id', 'delivery.message_id').select('delivery.invoice_id').where('delivery.invoice_id', 'in', rows.map((r) => r.id)).where('delivery.status', 'in', ['queued', 'sending', 'sent']).where(sql<boolean>`message.recipient_filter->>'template' = ${req.body.template}`).execute()).map((r) => r.invoice_id),
      );
      let alreadySent = 0;
      const toPrint: { invoiceId: string; number: string; name: string; reason: string }[] = [];
      const send: { personId: string; memberId: string | null; email: string; invoiceId: string }[] = [];
      for (const r of rows) {
        if (mailed.has(r.id)) {
          alreadySent++;
          continue;
        }
        const name = (r.recipient as { recipient: { name: string } } | null)?.recipient.name ?? '';
        if (r.status === 'draft' || r.status === 'cancelled' || !r.number) continue;
        const reason = r.preferred_channel === 'letter' ? 'bevorzugt Brief' : !r.email ? 'keine E-Mail-Adresse' : suppressed.has(emailHash(r.email)) ? 'Adresse unzustellbar' : null;
        if (reason) toPrint.push({ invoiceId: r.id, number: r.number, name, reason });
        else send.push({ personId: r.recipient_person_id, memberId: r.member_id, email: r.email!, invoiceId: r.id });
      }
      // One delivery per person and message: several invoices for one person go out as separate messages.
      const batches: (typeof send)[] = [];
      for (const s of send) {
        const batch = batches.find((b) => !b.some((x) => x.personId === s.personId));
        if (batch) batch.push(s);
        else batches.push([s]);
      }
      const ids: string[] = [];
      await db.transaction().execute(async (tx) => {
        for (const b of batches) {
          const id = await createMessage(tx, actor, { kind: 'invoices', category: 'notice', subject: req.body.subject ?? text.subject, body: req.body.body ?? text.body, filter: { template: req.body.template, invoiceIds: b.map((x) => x.invoiceId) } }, b);
          ids.push(id);
        }
      });
      reply.status(201);
      return { messages: await Promise.all(ids.map((id) => dto(actor, id))), sent: send.length, alreadySent, toPrint };
    },
  );

  async function templateFor(organizationId: string, key: SystemTemplateKey) {
    const t = await db.selectFrom('mail_template').select(['subject', 'body']).where('organization_id', '=', organizationId).where('key', '=', key).executeTakeFirst();
    return t ?? SYSTEM_TEMPLATES[key];
  }

  const templateDto = z.object({ id: z.string(), key: z.enum(TEMPLATE_KEYS).nullable(), name: z.string(), subject: z.string(), body: z.string(), category: z.enum(['notice', 'newsletter']), custom: z.boolean() });
  const templateInput = z.object({ name: z.string().trim().min(1).max(100), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(50_000), category: z.enum(['notice', 'newsletter']).default('notice') });
  const templateId = z.object({ id: z.union([z.enum(TEMPLATE_KEYS), z.uuid()]) });
  const isKey = (id: string): id is SystemTemplateKey => id in SYSTEM_TEMPLATES;

  app.get('/mail-templates', { schema: { tags, summary: 'Vorlagen: eigene und System-Texte (Rechnung, Mahnung, Einladung)', response: { 200: z.array(templateDto) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'read');
    const rows = await db.selectFrom('mail_template').selectAll().where('organization_id', '=', actor.organizationId).orderBy('name').execute();
    const system = (Object.keys(SYSTEM_TEMPLATES) as SystemTemplateKey[]).map((key) => {
      const own = rows.find((r) => r.key === key);
      return { id: key, key, name: SYSTEM_TEMPLATES[key].name, subject: own?.subject ?? SYSTEM_TEMPLATES[key].subject, body: own?.body ?? SYSTEM_TEMPLATES[key].body, category: 'notice' as const, custom: !!own };
    });
    return [...system, ...rows.filter((r) => !r.key).map((r) => ({ id: r.id, key: null, name: r.name, subject: r.subject, body: r.body, category: r.category, custom: true }))];
  });

  app.post('/mail-templates', { schema: { tags, summary: 'Eigene Vorlage anlegen', body: templateInput, response: { 201: templateDto } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    const t = await db.transaction().execute(async (tx) => {
      const t = await tx.insertInto('mail_template').values({ organization_id: actor.organizationId, ...req.body }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'mail_template.created', entityType: 'mail_template', entityId: t.id, diff: { name: [null, t.name] } });
      return t;
    });
    reply.status(201);
    return { id: t.id, key: null, name: t.name, subject: t.subject, body: t.body, category: t.category, custom: true };
  });

  /** System texts (id = 'invoice' | 'dunning' | 'invitation') belong to the club settings. */
  app.put('/mail-templates/:id', { schema: { tags, summary: 'Vorlage oder System-Text ändern', params: templateId, body: templateInput, response: { 200: templateDto } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    const id = req.params.id;
    if (isKey(id)) requirePermission(actor, 'settings', 'write');
    const v = { name: isKey(id) ? SYSTEM_TEMPLATES[id].name : req.body.name, subject: req.body.subject, body: req.body.body, category: isKey(id) ? ('notice' as const) : req.body.category, updated_at: new Date() };
    const t = await db.transaction().execute(async (tx) => {
      const t = isKey(id)
        ? await tx.insertInto('mail_template').values({ organization_id: actor.organizationId, key: id, ...v }).onConflict((oc) => oc.columns(['organization_id', 'key']).doUpdateSet(v)).returningAll().executeTakeFirstOrThrow()
        : await tx.updateTable('mail_template').set(v).where('id', '=', id).where('organization_id', '=', actor.organizationId).where('key', 'is', null).returningAll().executeTakeFirst();
      if (!t) throw notFound('Vorlage');
      await audit(tx, actor.organizationId, actor, { action: 'mail_template.updated', entityType: 'mail_template', entityId: t.id, diff: { name: [null, t.name] } });
      return t;
    });
    return { id: isKey(id) ? id : t.id, key: isKey(id) ? id : null, name: t.name, subject: t.subject, body: t.body, category: t.category, custom: true };
  });

  app.delete('/mail-templates/:id', { schema: { tags, summary: 'Vorlage löschen; bei System-Texten gilt danach wieder der Standardtext', params: templateId, response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    const id = req.params.id;
    if (isKey(id)) requirePermission(actor, 'settings', 'write');
    await db.transaction().execute(async (tx) => {
      const q = tx.deleteFrom('mail_template').where('organization_id', '=', actor.organizationId);
      const r = await (isKey(id) ? q.where('key', '=', id) : q.where('id', '=', id).where('key', 'is', null)).executeTakeFirst();
      if (!Number(r.numDeletedRows) && !isKey(id)) throw notFound('Vorlage');
      await audit(tx, actor.organizationId, actor, { action: 'mail_template.deleted', entityType: 'mail_template', entityId: isKey(id) ? null : id, diff: { template: [id, null] } });
    });
    reply.status(204);
    return null;
  });

  const unscopedOnly = (actor: Actor) => {
    if (scopeOf(actor, 'communication', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', undefined, { permission: 'communication:write (ganzer Verein)' });
  };

  app.post('/deliveries/:id/bounce', { schema: { tags, summary: 'Zustellung von Hand als unzustellbar markieren (sperrt die Adresse)', params: idParam, body: z.object({}).optional(), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    unscopedOnly(actor);
    await db.transaction().execute(async (tx) => {
      const d = await tx.updateTable('delivery').set({ status: 'bounced', error: 'von Hand als unzustellbar markiert' }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).returning(['email']).executeTakeFirst();
      if (!d) throw notFound('Zustellung');
      await tx.insertInto('suppression').values({ organization_id: actor.organizationId, email_hash: emailHash(d.email), reason: 'manual' }).onConflict((oc) => oc.doNothing()).execute();
      await audit(tx, actor.organizationId, actor, { action: 'mail.bounced_manually', entityType: 'delivery', entityId: req.params.id });
    });
    return { ok: true };
  });

  app.post('/mail/unblock', { schema: { tags, summary: 'Gesperrte Adresse wieder freigeben (z. B. nachdem das Postfach korrigiert ist); Abmeldungen bleiben bestehen', body: z.object({ email: z.email() }), response: { 200: z.object({ removed: z.boolean() }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'write');
    unscopedOnly(actor);
    const removed = await db.transaction().execute(async (tx) => {
      const r = await tx.deleteFrom('suppression').where('organization_id', '=', actor.organizationId).where('email_hash', '=', emailHash(req.body.email)).where('reason', '!=', 'unsubscribe').executeTakeFirst();
      await audit(tx, actor.organizationId, actor, { action: 'mail.unblocked', entityType: 'suppression', entityId: null });
      return Number(r.numDeletedRows) > 0;
    });
    return { removed };
  });

  async function dto(actor: Actor, id: string) {
    const m = await db.selectFrom('message').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!m) throw notFound('Nachricht');
    const c = await db.selectFrom('delivery').select(['status', sql<number>`count(*)::int`.as('n')]).where('message_id', '=', id).groupBy('status').execute();
    const n = (s: string[]) => c.filter((x) => s.includes(x.status)).reduce((a, x) => a + x.n, 0);
    return {
      id: m.id,
      kind: m.kind,
      category: m.category,
      subject: m.subject,
      body: m.body,
      status: m.status,
      createdBy: m.created_by_label,
      createdAt: m.created_at.toISOString(),
      counts: { total: n(['queued', 'sending', 'sent', 'failed', 'bounced']), sent: n(['sent']), queued: n(['queued', 'sending']), failed: n(['failed', 'bounced']) },
    };
  }

  app.get('/messages', { schema: { tags, summary: 'Versendete E-Mails', response: { 200: z.array(messageDto) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'read');
    let q = db.selectFrom('message').select('id').where('organization_id', '=', actor.organizationId);
    // Scoped users see what they sent themselves.
    if (scopeOf(actor, 'communication', 'read') !== null) q = q.where('created_by', '=', actor.userId);
    const ids = await q.orderBy('created_at', 'desc').limit(100).execute();
    return Promise.all(ids.map((r) => dto(actor, r.id)));
  });

  app.get('/messages/:id', { schema: { tags, summary: 'Nachricht mit Zustellprotokoll', params: idParam, response: { 200: messageDto.extend({ deliveries: z.array(deliveryDto) }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'read');
    const m = await dto(actor, req.params.id);
    const row = await db.selectFrom('message').select('created_by').where('id', '=', req.params.id).executeTakeFirstOrThrow();
    if (scopeOf(actor, 'communication', 'read') !== null && row.created_by !== actor.userId) throw notFound('Nachricht');
    const hide = restrictedFields(actor).has('email');
    const deliveries = await db
      .selectFrom('delivery')
      .innerJoin('person', 'person.id', 'delivery.person_id')
      .leftJoin('invoice', 'invoice.id', 'delivery.invoice_id')
      .select(['delivery.id', 'delivery.member_id', 'delivery.email', 'delivery.status', 'delivery.error', 'delivery.sent_at', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'invoice.number'])
      .where('delivery.message_id', '=', req.params.id)
      .orderBy('person.last_name')
      .execute();
    return { ...m, deliveries: deliveries.map((d) => ({ id: d.id, memberId: d.member_id, name: displayName({ kind: d.kind, firstName: d.first_name, lastName: d.last_name, companyName: d.company_name }), email: hide ? '•••' : d.email, status: d.status, error: hide ? (d.error ? 'Fehler (Details nur mit Recht auf E-Mail-Adressen)' : null) : d.error, sentAt: d.sent_at?.toISOString() ?? null, invoiceNumber: d.number })) };
  });

  app.get('/members/:id/deliveries', { schema: { tags, summary: 'E-Mails an ein Mitglied', params: idParam, response: { 200: z.array(z.object({ messageId: z.uuid(), subject: z.string(), status: z.string(), at: z.string() })) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'communication', 'read');
    const today = await orgToday(db, actor.organizationId);
    const ok = await db.selectFrom('member').select('id').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where(applyScope(actor, today, 'read', 'communication')).executeTakeFirst();
    if (!ok) throw notFound('Mitglied');
    const rows = await db.selectFrom('delivery').innerJoin('message', 'message.id', 'delivery.message_id').select(['message.id', 'message.subject', 'delivery.status', 'delivery.created_at']).where('delivery.member_id', '=', req.params.id).orderBy('delivery.created_at', 'desc').limit(50).execute();
    return rows.map((r) => ({ messageId: r.id, subject: r.subject, status: r.status, at: r.created_at.toISOString() }));
  });

  app.post('/mail/test', { schema: { tags, summary: 'Test-E-Mail an Dich selbst schicken (prüft die SMTP-Einstellungen, mit SPF- und DMARC-Hinweisen)', body: z.object({}).optional(), response: { 200: z.object({ to: z.string(), messageId: z.string().nullable(), hints: z.array(z.string()) }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    if (actor.kind !== 'user') throw new Problem(400, 'not-a-user', 'Nur für angemeldete Zugänge.');
    const user = await db.selectFrom('app_user').select('email').where('id', '=', actor.id).executeTakeFirstOrThrow();
    const org = await db.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const sender = senderOf(org);
    try {
      const info = await mailer().sendMail({ from: { name: sender.name, address: sender.address }, to: user.email, subject: `Test von OpenVerein (${org.name})`, text: 'Diese E-Mail zeigt: Der Versand aus OpenVerein funktioniert.' });
      return { to: user.email, messageId: info.messageId ?? null, hints: await dnsHints(sender.address) };
    } catch (err) {
      throw new Problem(502, 'smtp', 'Der Mailserver hat die Test-E-Mail nicht angenommen.', String((err as Error).message).slice(0, 300));
    }
  });

  async function unsubscribe(token: string) {
    const id = deliveryFromToken(token);
    const d = id ? await db.selectFrom('delivery').select(['organization_id', 'email']).where('id', '=', id).executeTakeFirst() : undefined;
    if (!id || !d) throw new Problem(400, 'invalid-token', 'Dieser Abmeldelink ist ungültig.');
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('suppression').values({ organization_id: d.organization_id, email_hash: emailHash(d.email), reason: 'unsubscribe' }).onConflict((oc) => oc.doNothing()).execute();
      await audit(tx, d.organization_id, null, { action: 'mail.unsubscribed', entityType: 'delivery', entityId: id });
    });
    return { ok: true };
  }

  app.post('/unsubscribe', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags, summary: 'Vom Rundschreiben abmelden (Link aus der E-Mail)', security: [], body: z.object({ token: z.string().max(200) }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => unsubscribe(req.body.token));

  // RFC 8058 one-click: mail programs POST "List-Unsubscribe=One-Click" as a form to the header URL.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, body, done) => done(null, body));
  app.post('/unsubscribe/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags, summary: 'Ein-Klick-Abmeldung (RFC 8058, für Mailprogramme)', security: [], params: z.object({ token: z.string().max(200) }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => unsubscribe(req.params.token));

  app.post('/mail/resume', { schema: { tags, summary: 'Angehaltenen Versand fortsetzen (nachdem die SMTP-Einstellungen stimmen)', body: z.object({}).optional(), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('organization').set({ mail_paused_reason: null }).where('id', '=', actor.organizationId).execute();
      await audit(tx, actor.organizationId, actor, { action: 'mail.resumed', entityType: 'organization', entityId: actor.organizationId });
    });
    return { ok: true };
  });
};

