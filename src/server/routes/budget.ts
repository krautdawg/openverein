import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { Problem } from '../http/problem.ts';
import { requireClubWide, type Actor } from '../policy.ts';

const tags = ['ledger'];
const year = z.number().int().min(2000).max(2100);
const row = z.object({ accountId: z.uuid(), number: z.string(), name: z.string(), kind: z.enum(['income', 'expense']), plannedCents: z.number().nullable(), actualCents: z.number() });

export const budgetRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** Net actuals per income/expense account for the year (income: credit − debit, expense: debit − credit). */
  async function report(actor: Actor, y: number) {
    const rows = await sql<{ id: string; number: string; name: string; kind: 'income' | 'expense'; planned: string | null; actual: string }>`
      select a.id, a.number, a.name, a.kind, b.planned_cents as planned,
        coalesce((select sum(case when a.kind = 'income' then l.credit_cents - l.debit_cents else l.debit_cents - l.credit_cents end)
          from journal_line l join journal_entry e on e.id = l.entry_id
          where l.account_id = a.id and e.entry_date between ${`${y}-01-01`}::date and ${`${y}-12-31`}::date), 0) as actual
      from ledger_account a
      left join budget_line b on b.account_id = a.id and b.year = ${y}
      where a.organization_id = ${actor.organizationId} and a.kind in ('income', 'expense')
        and (a.retired_at is null or b.account_id is not null)
      order by a.kind desc, a.number`.execute(db);
    return rows.rows.map((r) => ({ accountId: r.id, number: r.number, name: r.name, kind: r.kind, plannedCents: r.planned === null ? null : Number(r.planned), actualCents: Number(r.actual) }));
  }

  app.get('/ledger/budget', { schema: { tags, summary: 'Haushaltsplan eines Jahres: Plan und Ist je Einnahmen- und Ausgabenkonto (netto)', querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), response: { 200: z.array(row) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    return report(actor, req.query.year);
  });

  app.put('/ledger/budget', { schema: { tags, summary: 'Planwerte setzen (null entfernt den Plan für das Konto)', body: z.object({ year, lines: z.array(z.object({ accountId: z.uuid(), plannedCents: z.number().int().min(0).max(100_000_000_000).nullable() })).min(1).max(500) }), response: { 200: z.array(row) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const { year: y, lines } = req.body;
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const known = await db.selectFrom('ledger_account').select('id').where('organization_id', '=', actor.organizationId).where('kind', 'in', ['income', 'expense']).where('id', 'in', ids).execute();
    if (known.length !== ids.length) throw new Problem(400, 'validation', 'Planwerte gibt es nur für Einnahmen- und Ausgabenkonten des Vereins.');
    await db.transaction().execute(async (tx) => {
      for (const l of lines) {
        const planned = l.plannedCents;
        if (planned === null) await tx.deleteFrom('budget_line').where('organization_id', '=', actor.organizationId).where('year', '=', y).where('account_id', '=', l.accountId).execute();
        else await tx.insertInto('budget_line').values({ organization_id: actor.organizationId, year: y, account_id: l.accountId, planned_cents: planned }).onConflict((oc) => oc.columns(['organization_id', 'year', 'account_id']).doUpdateSet({ planned_cents: planned })).execute();
      }
      await audit(tx, actor.organizationId, actor, { action: 'ledger.budget_set', entityType: 'organization', entityId: actor.organizationId, diff: { year: [null, y], lines: [null, lines.length] } });
    });
    return report(actor, y);
  });
};
