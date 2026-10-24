import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { formatDate } from '../../shared/dates.ts';
import { displayName } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { blindIndex, decrypt, encrypt } from '../crypto.ts';
import type { ChangeField } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { sendSystemMail } from '../mail/system.ts';
import { applyScope, loadMemberRow, orgToday } from '../members/query.ts';
import { requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';
import { issueLoginCode } from './portal.ts';

const tags = ['members'];
const idParam = z.object({ id: z.uuid() });

export const FIELD_LABEL: Record<ChangeField, string> = { first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail-Adresse', phone: 'Telefon', address: 'Anschrift', iban: 'Bankverbindung', resignation: 'Kündigung' };
// IBAN changes need the right to see bank data; everything else is ordinary member data.
const FIELD_RIGHT: Partial<Record<ChangeField, string>> = { iban: 'iban', email: 'email', phone: 'phone', address: 'street' };
type Address = { street: string; postalCode: string; city: string };
type BankChange = { iban: string; accountHolder: string };
const addressText = (v: string) => {
  const a = JSON.parse(v) as Address;
  return `${a.street}, ${a.postalCode} ${a.city}`;
};

const changeDto = z.object({
  id: z.uuid(),
  memberId: z.uuid(),
  memberName: z.string(),
  field: z.enum(['first_name', 'last_name', 'email', 'phone', 'address', 'iban', 'resignation']),
  oldValue: z.string().nullable(),
  newValue: z.string(),
  status: z.enum(['pending', 'accepted', 'denied', 'superseded', 'applied']),
  reason: z.string().nullable(),
  requestedAt: z.string(),
});

export const changeRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  const show = (actor: Actor, field: ChangeField, value: string | null) => {
    if (value === null) return null;
    if (field === 'iban') {
      const b = JSON.parse(decrypt(value)) as BankChange;
      return restrictedFields(actor).has('iban') ? '••••' : `•••• ${b.iban.slice(-4)}, Inhaber:in ${b.accountHolder}`;
    }
    if (field === 'address') return restrictedFields(actor).has('street') ? '•••' : addressText(value);
    const right = FIELD_RIGHT[field];
    return right && restrictedFields(actor).has(right) ? '•••' : value;
  };

  app.get('/change-requests', { schema: { tags, summary: 'Änderungswünsche und Kündigungen aus dem Mitgliederportal', querystring: z.object({ status: z.enum(['pending', 'all']).default('pending') }), response: { 200: z.array(changeDto) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    const today = await orgToday(db, actor.organizationId);
    let q = db
      .selectFrom('change_request')
      .innerJoin('member', 'member.id', 'change_request.member_id')
      .innerJoin('person', 'person.id', 'change_request.person_id')
      .select(['change_request.id', 'change_request.member_id', 'change_request.field', 'change_request.old_value', 'change_request.new_value', 'change_request.status', 'change_request.reason', 'change_request.requested_at', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('change_request.organization_id', '=', actor.organizationId)
      .where(applyScope(actor, today, 'read'));
    q = req.query.status === 'pending' ? q.where('change_request.status', '=', 'pending') : q.where('change_request.status', '!=', 'superseded');
    const rows = await q.orderBy('change_request.requested_at', 'desc').limit(200).execute();
    return rows.map((r) => ({ id: r.id, memberId: r.member_id, memberName: displayName({ kind: r.kind, firstName: r.first_name, lastName: r.last_name, companyName: r.company_name }), field: r.field, oldValue: show(actor, r.field, r.old_value), newValue: show(actor, r.field, r.new_value)!, status: r.status, reason: r.reason, requestedAt: r.requested_at.toISOString() }));
  });

  async function load(actor: Actor, id: string) {
    const c = await db.selectFrom('change_request').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!c) throw notFound('Änderungswunsch');
    requirePermission(actor, 'members', 'write');
    const { row } = await loadMemberRow(db, actor, c.member_id, 'write');
    const right = FIELD_RIGHT[c.field];
    if (right && restrictedFields(actor).has(right)) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', undefined, { permission: `members.field.${right}` });
    if (c.field === 'iban') requirePermission(actor, 'sepa', 'write');
    if (c.status !== 'pending') throw new Problem(409, 'decided', 'Darüber ist schon entschieden.');
    return { c, member: row };
  }

  app.post(
    '/change-requests/:id/accept',
    { schema: { tags, summary: 'Änderung übernehmen (bei Kündigung mit Austrittsdatum, bei IBAN als Mandatsänderung)', params: idParam, body: z.object({ exitDate: z.iso.date().optional() }).optional(), response: { 200: changeDto.pick({ id: true, status: true }).extend({ needsNewMandate: z.boolean() }) } } },
    async (req) => {
      const actor = requireActor(req);
      const { c, member } = await load(actor, req.params.id);
      const today = await orgToday(db, actor.organizationId);
      let needsNewMandate = false;
      let message = '';
      await db.transaction().execute(async (tx) => {
        const locked = await tx.selectFrom('change_request').select('status').where('id', '=', c.id).forUpdate().executeTakeFirstOrThrow();
        if (locked.status !== 'pending') throw new Problem(409, 'decided', 'Darüber ist schon entschieden.');
        if (c.field === 'resignation') {
          const exit = req.body?.exitDate ?? c.new_value;
          const m = await tx.selectFrom('member').select(['status', 'join_date']).where('id', '=', c.member_id).forUpdate().executeTakeFirstOrThrow();
          if (!['active', 'future'].includes(m.status)) throw new Problem(409, 'invalid-transition', 'Die Mitgliedschaft ist nicht mehr aktiv.');
          if (m.join_date && exit < m.join_date) throw new Problem(400, 'exit-before-join', 'Das Austrittsdatum liegt vor dem Eintritt.');
          await tx.updateTable('member').set({ status: exit < today ? 'former' : 'resigned', notice_date: c.old_value ?? today, exit_date: exit, exit_reason: 'Kündigung über das Mitgliederportal', updated_at: new Date() }).where('id', '=', c.member_id).execute();
          await tx.updateTable('group_membership').set({ valid_to: exit }).where('member_id', '=', c.member_id).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', exit)])).where('valid_from', '<=', exit).execute();
          await audit(tx, actor.organizationId, actor, { action: 'member.resigned', entityType: 'member', entityId: c.member_id, diff: { exitDate: [null, exit], source: [null, 'portal'] } });
          message = `der Vorstand hat Deine Kündigung bestätigt. Deine Mitgliedschaft endet am ${formatDate(exit)}.`;
        } else if (c.field === 'iban') {
          const change = JSON.parse(decrypt(c.new_value)) as BankChange;
          const mandate = await tx.selectFrom('sepa_mandate').selectAll().where('person_id', '=', c.person_id).where('status', 'in', ['active', 'pending_evidence']).forUpdate().executeTakeFirst();
          if (!mandate) throw new Problem(409, 'no-mandate', 'Für dieses Mitglied gibt es kein Mandat.', 'Lehne den Wunsch ab und bitte um ein neues SEPA-Mandat.');
          if (change.accountHolder.trim().toLowerCase() !== mandate.account_holder.trim().toLowerCase()) {
            // Someone else's account: the old mandate does not cover it. Nothing changes until a new mandate is signed.
            needsNewMandate = true;
            message = `für das Konto von ${change.accountHolder} brauchen wir ein neues SEPA-Mandat mit dessen Unterschrift. Bis es vorliegt, bleibt es bei der bisherigen Bankverbindung.`;
          } else {
            // Same holder, same mandate: the bank learns about the new account with the next debit (amendment),
            // unless the bank has never seen this mandate (never collected, or still waiting for its signature).
            const amend = mandate.status === 'active' && mandate.first_collected && mandate.type === 'recurrent';
            await tx.updateTable('sepa_mandate').set({ iban_encrypted: encrypt(change.iban), iban_hash: blindIndex(change.iban), iban_last4: change.iban.slice(-4), bic: null, ...(amend ? { amended_from_iban_encrypted: mandate.amendment_pending ? mandate.amended_from_iban_encrypted : mandate.iban_encrypted, amendment_pending: true } : {}), updated_at: new Date() }).where('id', '=', mandate.id).execute();
            await audit(tx, actor.organizationId, actor, { action: 'mandate.amended', entityType: 'sepa_mandate', entityId: mandate.id, diff: { ibanLast4: [mandate.iban_last4, change.iban.slice(-4)], amendment: [null, amend] } });
            message = `wir haben Deine neue Bankverbindung (endet auf ${change.iban.slice(-4)}) übernommen. Die nächste Lastschrift kommt von diesem Konto.`;
          }
        } else if (c.field === 'address') {
          const a = JSON.parse(c.new_value) as Address;
          await tx.updateTable('person').set({ street: a.street, postal_code: a.postalCode, city: a.city, updated_at: new Date() }).where('id', '=', c.person_id).execute();
          await audit(tx, actor.organizationId, actor, { action: 'member.updated', entityType: 'member', entityId: c.member_id, diff: { address: [c.old_value ? addressText(c.old_value) : null, addressText(c.new_value)], source: [null, 'portal'] } });
          message = `wir haben Deine neue Anschrift übernommen: ${addressText(c.new_value)}.`;
        } else {
          await tx.updateTable('person').set({ [c.field]: c.new_value, updated_at: new Date() }).where('id', '=', c.person_id).execute();
          await audit(tx, actor.organizationId, actor, { action: 'member.updated', entityType: 'member', entityId: c.member_id, diff: { [c.field]: [c.old_value, c.new_value], source: [null, 'portal'] } });
          message = `wir haben Deine Änderung übernommen: ${FIELD_LABEL[c.field]} ist jetzt „${c.new_value}“.`;
        }
        await tx.updateTable('change_request').set({ status: 'accepted', decided_by: actor.userId, decided_at: new Date() }).where('id', '=', c.id).execute();
      });
      const to = c.field === 'email' ? c.new_value : member.email;
      if (to) await sendSystemMail(db, actor.organizationId, 'change_decided', to, { vorname: member.first_name ?? '', entscheidung: message });
      return { id: c.id, status: 'accepted' as const, needsNewMandate };
    },
  );

  app.post(
    '/change-requests/:id/deny',
    { schema: { tags, summary: 'Änderung ablehnen (mit Begründung an das Mitglied)', params: idParam, body: z.object({ reason: z.string().trim().min(3, 'Bitte gib eine Begründung an.').max(500) }), response: { 200: changeDto.pick({ id: true, status: true }) } } },
    async (req) => {
      const actor = requireActor(req);
      const { c, member } = await load(actor, req.params.id);
      await db.transaction().execute(async (tx) => {
        const r = await tx.updateTable('change_request').set({ status: 'denied', reason: req.body.reason, decided_by: actor.userId, decided_at: new Date() }).where('id', '=', c.id).where('status', '=', 'pending').executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new Problem(409, 'decided', 'Darüber ist schon entschieden.');
        await audit(tx, actor.organizationId, actor, { action: 'change_request.denied', entityType: 'member', entityId: c.member_id, diff: { field: [null, c.field] } });
      });
      if (member.email) await sendSystemMail(db, actor.organizationId, 'change_decided', member.email, { vorname: member.first_name ?? '', entscheidung: `Deine Änderung (${FIELD_LABEL[c.field]}) haben wir nicht übernommen. Begründung: ${req.body.reason}` });
      return { id: c.id, status: 'denied' as const };
    },
  );

  app.post(
    '/members/:id/portal-code',
    { schema: { tags, summary: 'Anmeldecode für das Mitgliederportal ausgeben (falls die E-Mail nicht ankommt); einmal sichtbar, 24 Stunden gültig', params: idParam, body: z.object({}).optional(), response: { 200: z.object({ code: z.string(), email: z.string(), expiresInHours: z.number() }) } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'members', 'write');
      if (actor.kind !== 'user') throw new Problem(403, 'forbidden', 'Nur für angemeldete Zugänge.');
      // The code opens every membership under the address, so only club-wide admins may hand one out.
      if (scopeOf(actor, 'members', 'write') !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', 'Portal-Codes geben Zugänge für den ganzen Verein aus.', { permission: 'members:write (ganzer Verein)' });
      const { row } = await loadMemberRow(db, actor, req.params.id, 'write');
      if (!row.email) throw new Problem(409, 'no-email', 'Das Mitglied hat keine E-Mail-Adresse; das Portal meldet über die Adresse an.');
      if (!['active', 'future', 'resigned'].includes(row.status)) throw new Problem(409, 'not-current', 'Nur aktuelle Mitglieder können sich im Portal anmelden.');
      const code = await db.transaction().execute(async (tx) => {
        const code = await issueLoginCode(tx, actor.organizationId, row.email!, actor.userId);
        await audit(tx, actor.organizationId, actor, { action: 'portal.code_issued', entityType: 'member', entityId: row.id });
        return code;
      });
      return { code, email: restrictedFields(actor).has('email') ? '•••' : row.email, expiresInHours: 24 };
    },
  );
};
