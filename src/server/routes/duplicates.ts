import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { notFound, Problem } from '../http/problem.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide } from '../policy.ts';

const tags = ['members'];
const side = z.object({ personId: z.uuid(), memberId: z.uuid().nullable(), name: z.string(), membershipNumber: z.string().nullable(), birthDate: z.string().nullable(), email: z.string().nullable(), street: z.string().nullable(), postalCode: z.string().nullable(), city: z.string().nullable() });
const pair = z.object({ score: z.number(), matches: z.array(z.enum(['name', 'birthDate', 'email', 'iban', 'address'])), a: side, b: side });
const ordered = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];

/**
 * Score 0–100: name similarity (trigram) up to 50, same birth date 20, same e-mail 15, same IBAN 10, same address 5.
 * Candidates need at least one strong signal, so the self-join stays small.
 */
export const duplicateRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/members/duplicates', { schema: { tags, summary: 'Mögliche Dubletten mit Punktzahl und übereinstimmenden Feldern', querystring: z.object({ threshold: z.coerce.number().int().min(60).max(100).default(80) }), response: { 200: z.array(pair) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const rows = await sql<Record<string, string | number | null> & { score: number; name_sim: number; same_birth: boolean; same_email: boolean; same_iban: boolean; same_address: boolean }>`
      with p as (
        select p.id, p.first_name, p.last_name, p.company_name, p.kind, p.birth_date, p.email, p.street, p.postal_code, p.city,
          -- German spellings compare equal: Müller = Mueller, Strauß = Strauss.
          unaccent(replace(replace(replace(replace(lower(coalesce(p.last_name, '') || ' ' || coalesce(p.first_name, '') || ' ' || coalesce(p.company_name, '')), 'ü', 'ue'), 'ö', 'oe'), 'ä', 'ae'), 'ß', 'ss')) as n,
          m.id as member_id, m.membership_number,
          (select array_agg(iban_hash) from sepa_mandate s where s.person_id = p.id) as ibans
        from person p left join member m on m.person_id = p.id
        where p.organization_id = ${actor.organizationId} and p.status = 'active' and p.anonymised_at is null
      ), c as (
        select a.*, b.id as b_id, b.first_name as b_first, b.last_name as b_last, b.company_name as b_company, b.kind as b_kind, b.birth_date as b_birth, b.email as b_email,
          b.street as b_street, b.postal_code as b_postal, b.city as b_city, b.member_id as b_member, b.membership_number as b_number,
          similarity(a.n, b.n) as name_sim,
          (a.birth_date is not null and a.birth_date = b.birth_date) as same_birth,
          (a.email is not null and lower(a.email) = lower(b.email)) as same_email,
          (a.ibans && b.ibans) as same_iban,
          (a.street is not null and lower(regexp_replace(a.street, '\\s+', '', 'g')) = lower(regexp_replace(b.street, '\\s+', '', 'g')) and a.postal_code = b.postal_code) as same_address
        from p a join p b on a.id < b.id
        where a.n % b.n or (a.email is not null and lower(a.email) = lower(b.email)) or (a.ibans && b.ibans)
      )
      select *, round(least(name_sim, 1) * 50 + case when same_birth then 20 else 0 end + case when same_email then 15 else 0 end
        + case when coalesce(same_iban, false) then 10 else 0 end + case when same_address then 5 else 0 end)::int as score
      from c
      where not exists (select 1 from duplicate_dismissal d where d.person_a = c.id and d.person_b = c.b_id)
      order by score desc limit 500`.execute(db);
    const nameOf = (kind: unknown, first: unknown, last: unknown, company: unknown) => (kind === 'organisation' ? String(company ?? '') : [first, last].filter(Boolean).join(' '));
    return rows.rows
      .filter((r) => r.score >= req.query.threshold)
      .slice(0, 200)
      .map((r) => ({
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
    const { keepPersonId, archivePersonId } = req.body;
    if (keepPersonId === archivePersonId) throw new Problem(400, 'validation', 'Zwei verschiedene Personen angeben.');
    await db.transaction().execute(async (tx) => {
      const persons = await tx.selectFrom('person').select(['id', 'status']).where('organization_id', '=', actor.organizationId).where('id', 'in', [keepPersonId, archivePersonId]).forUpdate().execute();
      if (persons.length !== 2) throw notFound('Person');
      if (persons.find((p) => p.id === archivePersonId)!.status === 'archived') throw new Problem(409, 'archived', 'Diese Person ist schon archiviert.');
      // Financial records stay with the person they were issued to: such a duplicate cannot be archived here.
      const checks: [string, () => Promise<unknown>][] = [
        ['Rechnungen', () => tx.selectFrom('invoice').select('id').where('recipient_person_id', '=', archivePersonId).executeTakeFirst()],
        ['SEPA-Mandate', () => tx.selectFrom('sepa_mandate').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Spenden', () => tx.selectFrom('donation').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Lastschriften', () => tx.selectFrom('collection_item').select('id').where('person_id', '=', archivePersonId).executeTakeFirst()],
        ['Haushalte', () => tx.selectFrom('household').select('id').where('payer_person_id', '=', archivePersonId).executeTakeFirst()],
        ['Beitragsabrechnungen', () => tx.selectFrom('assessment').innerJoin('member', 'member.id', 'assessment.member_id').select('assessment.id').where('member.person_id', '=', archivePersonId).executeTakeFirst()],
      ];
      const blocked: string[] = [];
      for (const [label, check] of checks) if (await check()) blocked.push(label);
      if (blocked.length) throw new Problem(409, 'has-financial-records', 'Diese Dublette hat Finanzdaten und bleibt bestehen.', `Vorhanden: ${blocked.join(', ')}. Archiviere stattdessen die andere Person, oder bereinige von Hand.`, { blockers: blocked });
      const today = await orgToday(tx, actor.organizationId);
      const keep = await tx.selectFrom('person').leftJoin('member', 'member.person_id', 'person.id').select(['member.membership_number']).where('person.id', '=', keepPersonId).executeTakeFirst();
      await tx.updateTable('member').set({ status: 'former', exit_date: sql<string>`greatest(${today}::date, coalesce(join_date, ${today}::date))`, exit_reason: `Dublette${keep?.membership_number ? ` von Nr. ${keep.membership_number}` : ''}`, household_id: null, updated_at: new Date() }).where('person_id', '=', archivePersonId).where('status', 'not in', ['former', 'rejected']).execute();
      await tx.updateTable('person').set({ status: 'archived', updated_at: new Date() }).where('id', '=', archivePersonId).execute();
      const [a, b] = ordered(keepPersonId, archivePersonId);
      await tx.insertInto('duplicate_dismissal').values({ organization_id: actor.organizationId, person_a: a, person_b: b, dismissed_by: actor.userId }).onConflict((oc) => oc.doNothing()).execute();
      await audit(tx, actor.organizationId, actor, { action: 'duplicate.archived', entityType: 'person', entityId: archivePersonId, diff: { keep: [null, keepPersonId] } });
    });
    return reply.status(204).send();
  });
};
