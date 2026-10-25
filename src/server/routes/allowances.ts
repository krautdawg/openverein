import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ALLOWANCE_KINDS, allowanceLimit, type AllowanceKind } from '../../shared/allowances.ts';
import { displayName } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { notFound } from '../http/problem.ts';
import { requireClubWide, type Actor } from '../policy.ts';

const tags = ['ledger'];
const kind = z.enum(ALLOWANCE_KINDS);
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
const row = z.object({ personId: z.uuid(), name: z.string(), kind, paidCents: z.number(), otherCents: z.number(), limitCents: z.number(), remainingCents: z.number(), payments: z.array(z.object({ id: z.uuid(), paidOn: z.string(), amountCents: z.number(), text: z.string() })) });

export const allowanceRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** Per person and kind: paid by this club, declared as used elsewhere, the limit and what is left. */
  async function overview(actor: Actor, year: number, onlyPerson?: string) {
    let pq = db.selectFrom('allowance_payment').innerJoin('person', 'person.id', 'allowance_payment.person_id')
      .select(['allowance_payment.id', 'allowance_payment.person_id', 'allowance_payment.kind', 'allowance_payment.paid_on', 'allowance_payment.amount_cents', 'allowance_payment.text', 'person.kind as pkind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('allowance_payment.organization_id', '=', actor.organizationId).where('paid_on', '>=', `${year}-01-01`).where('paid_on', '<=', `${year}-12-31`);
    if (onlyPerson) pq = pq.where('allowance_payment.person_id', '=', onlyPerson);
    const payments = await pq.orderBy('paid_on').execute();
    const declarations = await db.selectFrom('allowance_declaration').innerJoin('person', 'person.id', 'allowance_declaration.person_id')
      .select(['allowance_declaration.person_id', 'allowance_declaration.kind', 'allowance_declaration.other_cents', 'person.kind as pkind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('allowance_declaration.organization_id', '=', actor.organizationId).where('year', '=', year).execute();
    const rows = new Map<string, z.infer<typeof row>>();
    const get = (personId: string, k: AllowanceKind, n: { pkind: string; first_name: string | null; last_name: string | null; company_name: string | null }) => {
      const key = `${personId}:${k}`;
      let r = rows.get(key);
      if (!r) {
        r = { personId, name: displayName({ kind: n.pkind, firstName: n.first_name, lastName: n.last_name, companyName: n.company_name }), kind: k, paidCents: 0, otherCents: 0, limitCents: allowanceLimit(k, year), remainingCents: 0, payments: [] };
        rows.set(key, r);
      }
      return r;
    };
    for (const p of payments) {
      const r = get(p.person_id, p.kind, p);
      r.paidCents += Number(p.amount_cents);
      r.payments.push({ id: p.id, paidOn: p.paid_on, amountCents: Number(p.amount_cents), text: p.text });
    }
    for (const d of declarations) if (!onlyPerson || d.person_id === onlyPerson) get(d.person_id, d.kind, d).otherCents = Number(d.other_cents);
    for (const r of rows.values()) r.remainingCents = r.limitCents - r.paidCents - r.otherCents;
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'de') || a.kind.localeCompare(b.kind));
  }

  app.get('/allowances', { schema: { tags, summary: 'Übungsleiter- und Ehrenamtspauschalen eines Jahres je Person: gezahlt, anderweitig erklärt, Grenze, Rest', querystring: yearQuery, response: { 200: z.array(row) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    return overview(actor, req.query.year);
  });

  app.post('/allowances/payments', { schema: { tags, summary: 'Pauschale festhalten (die Auszahlung selbst wird wie jede Ausgabe gebucht); warnt, wenn die steuerfreie Grenze überschritten wird', body: z.object({ personId: z.uuid(), kind, paidOn: z.iso.date(), amountCents: z.number().int().positive().max(10_000_000), text: z.string().trim().min(1, 'Wofür?').max(200) }), response: { 201: z.object({ row, warning: z.string().nullable() }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    if (!(await db.selectFrom('person').select('id').where('id', '=', b.personId).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw notFound('Person');
    await db.transaction().execute(async (tx) => {
      const p = await tx.insertInto('allowance_payment').values({ organization_id: actor.organizationId, person_id: b.personId, kind: b.kind, paid_on: b.paidOn, amount_cents: b.amountCents, text: b.text, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'allowance.paid', entityType: 'person', entityId: b.personId, diff: { kind: [null, b.kind], amountCents: [null, b.amountCents], payment: [null, p.id] } });
    });
    const year = Number(b.paidOn.slice(0, 4));
    const r = (await overview(actor, year, b.personId)).find((x) => x.kind === b.kind)!;
    reply.status(201);
    // The limit is a tax rule for the person, not a booking rule: record the payment and say what it means.
    const warning = r.remainingCents < 0 ? `Die steuerfreie Grenze von ${(r.limitCents / 100).toLocaleString('de-DE')} € ist um ${(-r.remainingCents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 })} € überschritten. Der Teil darüber ist steuer- und gegebenenfalls sozialversicherungspflichtig.` : null;
    return { row: r, warning };
  });

  app.delete('/allowances/payments/:id', { schema: { tags, summary: 'Falsch erfasste Pauschale löschen', params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    await db.transaction().execute(async (tx) => {
      const p = await tx.deleteFrom('allowance_payment').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).returning(['person_id', 'amount_cents', 'kind']).executeTakeFirst();
      if (!p) throw notFound('Zahlung');
      await audit(tx, actor.organizationId, actor, { action: 'allowance.deleted', entityType: 'person', entityId: p.person_id, diff: { kind: [p.kind, null], amountCents: [Number(p.amount_cents), null] } });
    });
    return reply.status(204).send();
  });

  app.put('/allowances/declarations', { schema: { tags, summary: 'Erklärung der Person: im Jahr schon anderweitig genutzter Teil der Pauschale', body: z.object({ personId: z.uuid(), year: z.number().int().min(2000).max(2100), kind, otherCents: z.number().int().min(0).max(10_000_000), declaredOn: z.iso.date() }), response: { 200: z.array(row) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    if (!(await db.selectFrom('person').select('id').where('id', '=', b.personId).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw notFound('Person');
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('allowance_declaration').values({ organization_id: actor.organizationId, person_id: b.personId, year: b.year, kind: b.kind, other_cents: b.otherCents, declared_on: b.declaredOn })
        .onConflict((oc) => oc.columns(['person_id', 'year', 'kind']).doUpdateSet({ other_cents: b.otherCents, declared_on: b.declaredOn })).execute();
      await audit(tx, actor.organizationId, actor, { action: 'allowance.declared', entityType: 'person', entityId: b.personId, diff: { year: [null, b.year], kind: [null, b.kind], otherCents: [null, b.otherCents] } });
    });
    return overview(actor, b.year, b.personId);
  });
};
