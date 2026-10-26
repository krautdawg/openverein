import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { CONSTRAINT_MESSAGES, notFound, Problem } from '../http/problem.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide, requireStepUp, restrictedFields } from '../policy.ts';

const tags = ['members'];
const side = z.object({ personId: z.uuid(), memberId: z.uuid().nullable(), name: z.string(), membershipNumber: z.string().nullable(), birthDate: z.string().nullable(), email: z.string().nullable(), street: z.string().nullable(), postalCode: z.string().nullable(), city: z.string().nullable() });
const pair = z.object({ score: z.number(), matches: z.array(z.enum(['name', 'birthDate', 'email', 'iban', 'address'])), a: side, b: side });
const ordered = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];
CONSTRAINT_MESSAGES.person_archived = 'Diese Person ist als Dublette archiviert. Nimm die Person, die geblieben ist.';
/** Scoring and even which pairs appear reveal these fields, so the search needs all of them visible. */
const SCORING_FIELDS = ['birth_date', 'email', 'iban'];

/** Score 0–100: name similarity (trigram) up to 50, same birth date 20, same e-mail 15, same IBAN 10, same address 5. */
export const duplicateRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/members/duplicates', { schema: { tags, summary: 'Mögliche Dubletten mit Punktzahl und übereinstimmenden Feldern', querystring: z.object({ threshold: z.coerce.number().int().min(60).max(100).default(80) }), response: { 200: z.array(pair) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const hidden = restrictedFields(actor);
    if (SCORING_FIELDS.some((f) => hidden.has(f))) throw new Problem(403, 'forbidden', 'Die Dublettensuche braucht Einblick in Geburtsdatum, E-Mail und IBAN.', 'Sie vergleicht diese Felder; schon die Treffer würden verraten, was Deine Rolle nicht sieht.', { permission: 'fields' });
    const key = (t: 'a' | 'b') => sql.raw(`ov_dup_key(${t}.first_name, ${t}.last_name, ${t}.company_name)`);
    const live = (t: 'a' | 'b') => sql`${sql.ref(`${t}.organization_id`)} = ${actor.organizationId} and ${sql.ref(`${t}.status`)} = 'active' and ${sql.ref(`${t}.anonymised_at`)} is null`;
    // Candidates come from index-backed keys (trigram name, e-mail, shared IBAN); only those pairs are scored.
    const rows = await sql<Record<string, string | number | null> & { score: number; name_sim: number; same_birth: boolean; same_email: boolean; same_iban: boolean; same_address: boolean }>`
      with cand as (
        select a.id as a_id, b.id as b_id from person a join person b on ${key('a')} % ${key('b')} and a.id < b.id where ${live('a')} and ${live('b')}
        union
        select a.id, b.id from person a join person b on lower(a.email) = lower(b.email) and a.id < b.id where a.email is not null and ${live('a')} and ${live('b')}
        union
        select least(ma.person_id, mb.person_id), greatest(ma.person_id, mb.person_id) from sepa_mandate ma join sepa_mandate mb on ma.iban_hash = mb.iban_hash and ma.person_id < mb.person_id
          where ma.organization_id = ${actor.organizationId}
      ), scored as (
        select a.id, a.first_name, a.last_name, a.company_name, a.kind, a.birth_date, a.email, a.street, a.postal_code, a.city, ma.id as member_id, ma.membership_number,
          b.id as b_id, b.first_name as b_first, b.last_name as b_last, b.company_name as b_company, b.kind as b_kind, b.birth_date as b_birth, b.email as b_email,
          b.street as b_street, b.postal_code as b_postal, b.city as b_city, mb.id as b_member, mb.membership_number as b_number,
          similarity(${key('a')}, ${key('b')}) as name_sim,
          (a.birth_date is not null and a.birth_date = b.birth_date) as same_birth,
          (a.email is not null and lower(a.email) = lower(b.email)) as same_email,
          exists (select 1 from sepa_mandate x join sepa_mandate y on x.iban_hash = y.iban_hash where x.person_id = a.id and y.person_id = b.id) as same_iban,
          (a.street is not null and lower(regexp_replace(a.street, '\\s+', '', 'g')) = lower(regexp_replace(b.street, '\\s+', '', 'g')) and a.postal_code = b.postal_code) as same_address
        from cand join person a on a.id = cand.a_id join person b on b.id = cand.b_id
        left join member ma on ma.person_id = a.id left join member mb on mb.person_id = b.id
        where ${live('a')} and ${live('b')}
          and not exists (select 1 from duplicate_dismissal d where d.person_a = cand.a_id and d.person_b = cand.b_id)
      )
      select * from (
        select *, round(least(name_sim, 1) * 50 + case when same_birth then 20 else 0 end + case when same_email then 15 else 0 end
          + case when same_iban then 10 else 0 end + case when same_address then 5 else 0 end)::int as score
        from scored
      ) x where score >= ${req.query.threshold}
      order by score desc, id, b_id limit 200`.execute(db);
    const nameOf = (kind: unknown, first: unknown, last: unknown, company: unknown) => (kind === 'organisation' ? String(company ?? '') : [first, last].filter(Boolean).join(' '));
    return rows.rows.map((r) => ({
        score: r.score,
        matches: [r.name_sim >= 0.6 ? 'name' : null, r.same_birth ? 'birthDate' : null, r.same_email ? 'email' : null, r.same_iban ? 'iban' : null, r.same_address ? 'address' : null].filter((x): x is 'name' => !!x),
        a: { personId: String(r.id), memberId: (r.member_id as string) ?? null, name: nameOf(r.kind, r.first_name, r.last_name, r.company_name), membershipNumber: (r.membership_number as string) ?? null, birthDate: (r.birth_date as string) ?? null, email: (r.email as string) ?? null, street: (r.street as string) ?? null, postalCode: (r.postal_code as string) ?? null, city: (r.city as string) ?? null },
        b: { personId: String(r.b_id), memberId: (r.b_member as string) ?? null, name: nameOf(r.b_kind, r.b_first, r.b_last, r.b_company), membershipNumber: (r.b_number as string) ?? null, birthDate: (r.b_birth as string) ?? null, email: (r.b_email as string) ?? null, street: (r.b_street as string) ?? null, postalCode: (r.b_postal as string) ?? null, city: (r.b_city as string) ?? null },
      }));
  });

  app.post('/members/duplicates/dismiss', { schema: { tags, summary: 'Paar als „keine Dublette“ merken', body: z.object({ personA: z.uuid(), personB: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    const [a, b] = ordered(req.body.personA, req.body.personB);
    if (a === b) throw new Problem(400, 'validation', 'Zwei verschiedene Personen angeben.');
    const found = await db.selectFrom('person').select('id').where('organization_id', '=', actor.organizationId).where('id', 'in', [a, b]).execute();
    if (found.length !== 2) throw notFound('Person');
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('duplicate_dismissal').values({ organization_id: actor.organizationId, person_a: a, person_b: b, dismissed_by: actor.userId }).onConflict((oc) => oc.doNothing()).execute();
      await audit(tx, actor.organizationId, actor, { action: 'duplicate.dismissed', entityType: 'person', entityId: a, diff: { other: [null, b] } });
    });
    return reply.status(204).send();
  });

  app.post('/members/duplicates/resolve', { schema: { tags, summary: 'Dublette archivieren (nur ohne Finanzdaten); die Mitgliedschaft endet heute mit dem Grund „Dublette“', body: z.object({ keepPersonId: z.uuid(), archivePersonId: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    // It ends fee assignments and a membership: fee rights and a fresh second factor.
    requireClubWide(actor, 'fees', 'write');
    requireStepUp(actor);
    const { keepPersonId, archivePersonId } = req.body;
    if (keepPersonId === archivePersonId) throw new Problem(400, 'validation', 'Zwei verschiedene Personen angeben.');
    await db.transaction().execute(async (tx) => {
      const persons = await tx.selectFrom('person').select(['id', 'status']).where('organization_id', '=', actor.organizationId).where('id', 'in', [keepPersonId, archivePersonId]).forUpdate().execute();
      if (persons.length !== 2) throw notFound('Person');
      // Only a pair the search would propose: similar name, same e-mail or same IBAN.
      const [pa, pb] = ordered(keepPersonId, archivePersonId);
      const plausible = await sql<{ ok: boolean }>`select (ov_dup_key(a.first_name, a.last_name, a.company_name) % ov_dup_key(b.first_name, b.last_name, b.company_name))
          or (a.email is not null and lower(a.email) = lower(b.email))
          or exists (select 1 from sepa_mandate x join sepa_mandate y on x.iban_hash = y.iban_hash where x.person_id = a.id and y.person_id = b.id) as ok
        from person a, person b where a.id = ${pa} and b.id = ${pb}`.execute(tx);
      if (!plausible.rows[0]?.ok) throw new Problem(409, 'not-a-duplicate', 'Diese beiden Personen sind keine mögliche Dublette.', 'Archivieren geht nur für Paare mit ähnlichem Namen, gleicher E-Mail-Adresse oder gleicher IBAN.');
      // Both must still be active: two opposite clicks at once must not archive both.
      if (persons.some((p) => p.status !== 'active')) throw new Problem(409, 'archived', 'Eine der beiden Personen ist schon archiviert.', 'Lade die Liste neu.');
      // Financial records stay with the person they were issued to: such a duplicate cannot be archived here.
      const checks: [string, () => Promise<unknown>][] = [
        ['Rechnungen', () => tx.selectFrom('invoice').select('id').where('recipient_person_id', '=', archivePersonId).executeTakeFirst()],
        ['SEPA-Mandate', () => tx.selectFrom('sepa_mandate').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Spenden', () => tx.selectFrom('donation').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Lastschriften', () => tx.selectFrom('collection_item').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Haushalte', () => tx.selectFrom('household').select('id').where('payer_person_id', '=', archivePersonId).executeTakeFirst()],
        ['Beitragsabrechnungen', () => tx.selectFrom('assessment').innerJoin('member', 'member.id', 'assessment.member_id').select('assessment.id').where('member.person_id', '=', archivePersonId).executeTakeFirst()],
        ['Angebote', () => tx.selectFrom('offer').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Pauschalen', () => tx.selectFrom('allowance_payment').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Pauschalen-Erklärungen', () => tx.selectFrom('allowance_declaration').select('person_id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Auslagen', () => tx.selectFrom('expense_claim').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
      ];
      // New records for this person wait for this transaction (row lock above) and are refused once it is archived (migration 0064).
      const blocked: string[] = [];
      for (const [label, check] of checks) if (await check()) blocked.push(label);
      if (blocked.length) throw new Problem(409, 'has-financial-records', 'Diese Dublette hat Finanzdaten und bleibt bestehen.', `Vorhanden: ${blocked.join(', ')}. Archiviere stattdessen die andere Person, oder bereinige von Hand.`, { blockers: blocked });
      const today = await orgToday(tx, actor.organizationId);
      const keep = await tx.selectFrom('person').leftJoin('member', 'member.person_id', 'person.id').select(['member.membership_number']).where('person.id', '=', keepPersonId).executeTakeFirst();
      const m = await tx.selectFrom('member').selectAll().where('person_id', '=', archivePersonId).executeTakeFirst();
      let feeChanges: { ended: string[]; removed: string[] } | null = null;
      if (m && !['former', 'rejected'].includes(m.status)) {
        const exit = m.join_date && m.join_date > today ? m.join_date : today;
        // An applicant was never admitted: rejected, not former. Never-billed fee assignments go (no assessment exists, checked above).
        await tx.updateTable('member').set({ status: m.status === 'applicant' ? 'rejected' : 'former', exit_date: m.status === 'applicant' ? null : exit, exit_reason: `Dublette${keep?.membership_number ? ` von Nr. ${keep.membership_number}` : ''}`, household_id: null, updated_at: new Date() }).where('id', '=', m.id).execute();
        // Fee assignments end with the membership (history stays); ones that had not started yet are removed.
        const ended = await tx.updateTable('fee_assignment').set({ valid_to: exit }).where('member_id', '=', m.id).where('valid_from', '<=', exit).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', exit)])).returning('id').execute();
        const dropped = await tx.deleteFrom('fee_assignment').where('member_id', '=', m.id).where('valid_from', '>', exit).returning('id').execute();
        feeChanges = { ended: ended.map((x) => x.id), removed: dropped.map((x) => x.id) };
        // Group memberships end with the membership; ones that had not started yet are removed.
        await tx.deleteFrom('group_membership').where('member_id', '=', m.id).where('valid_from', '>', exit).execute();
        await tx.updateTable('group_membership').set({ valid_to: exit }).where('member_id', '=', m.id).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', exit)])).execute();
      }
      await tx.updateTable('person').set({ status: 'archived', updated_at: new Date() }).where('id', '=', archivePersonId).execute();
      const [a, b] = ordered(keepPersonId, archivePersonId);
      await tx.insertInto('duplicate_dismissal').values({ organization_id: actor.organizationId, person_a: a, person_b: b, dismissed_by: actor.userId }).onConflict((oc) => oc.doNothing()).execute();
      await audit(tx, actor.organizationId, actor, { action: 'duplicate.archived', entityType: 'person', entityId: archivePersonId, diff: { keep: [null, keepPersonId], memberStatus: [m?.status ?? null, m ? (m.status === 'applicant' ? 'rejected' : 'former') : null], feeAssignments: [null, feeChanges] } });
    });
    return reply.status(204).send();
  });
};
