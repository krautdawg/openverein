import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addDays, formatDate } from '../../shared/dates.ts';
import { grossFromNet } from '../../shared/invoices.ts';
import { displayName } from '../../shared/members.ts';
import { offer, offerCreate, offerPatch } from '../../shared/offers.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { renderInvoicePdf } from '../invoices/pdf.ts';
import { createDraft, lineTotal, personLines } from '../invoices/service.ts';
import { loadMemberRow, orgToday } from '../members/query.ts';
import { nextNumber } from '../members/numbers.ts';
import { requireClubWide, type Actor } from '../policy.ts';

const tags = ['invoices'];
const idParam = z.object({ id: z.uuid() });
type LineIn = z.infer<typeof offerCreate>['lines'][number];

/**
 * Offers (spec P21): a document of their own, never a receivable and never in the ledger. Club-wide invoice rights,
 * because an offer is the step before an invoice. Issued offers are frozen (DB trigger); conversion creates an invoice draft.
 */
export const offerRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function dto(actor: Actor, id: string) {
    const o = await db.selectFrom('offer').innerJoin('person', 'person.id', 'offer.person_id').selectAll('offer').select(['person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('offer.id', '=', id).where('offer.organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!o) throw notFound('Angebot');
    const lines = await db.selectFrom('offer_line').selectAll().where('offer_id', '=', o.id).orderBy('position').execute();
    const today = await orgToday(db, actor.organizationId);
    return {
      id: o.id, number: o.number, status: o.status, memberId: o.member_id,
      // Same form as every list (Nachname, Vorname); the PDF keeps the address as it was sent.
      recipientName: displayName({ kind: o.kind, firstName: o.first_name, lastName: o.last_name, companyName: o.company_name }),
      issueDate: o.issue_date, validUntil: o.valid_until, expired: o.status === 'sent' && !!o.valid_until && o.valid_until < today,
      coverText: o.cover_text, closingText: o.closing_text, totalCents: Number(o.total_cents), invoiceId: o.invoice_id,
      lines: lines.map((l) => ({ position: l.position, text: l.text, quantity: Number(l.quantity), unitCents: Number(l.unit_cents), totalCents: Number(l.total_cents), taxRate: Number(l.tax_rate) })),
      createdAt: o.created_at.toISOString(),
    };
  }

  async function writeLines(tx: Db, organizationId: string, offerId: string, lines: LineIn[]) {
    await tx.deleteFrom('offer_line').where('offer_id', '=', offerId).execute();
    let total = 0;
    for (const [i, l] of lines.entries()) {
      const unit = l.net ? grossFromNet(l.unitCents, l.taxRate) : l.unitCents;
      const t = lineTotal(l.quantity, unit);
      total += t;
      await tx.insertInto('offer_line').values({ organization_id: organizationId, offer_id: offerId, position: i + 1, text: l.text, quantity: l.quantity, unit_cents: unit, total_cents: t, tax_rate: l.taxRate }).execute();
    }
    await tx.updateTable('offer').set({ total_cents: total, updated_at: new Date() }).where('id', '=', offerId).execute();
  }

  async function loadDraft(actor: Actor, id: string) {
    const o = await db.selectFrom('offer').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!o) throw notFound('Angebot');
    return o;
  }

  app.get('/offers', { schema: { tags, summary: 'Angebote, neueste zuerst', response: { 200: z.array(offer) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'read');
    const ids = await db.selectFrom('offer').select('id').where('organization_id', '=', actor.organizationId).orderBy('created_at', 'desc').limit(500).execute();
    return Promise.all(ids.map((r) => dto(actor, r.id)));
  });

  app.get('/offers/:id', { schema: { tags, summary: 'Angebot mit Positionen', params: idParam, response: { 200: offer } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'read');
    return dto(actor, req.params.id);
  });

  app.post('/offers', { schema: { tags, summary: 'Angebot als Entwurf anlegen', body: offerCreate, response: { 201: offer } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const { row } = await loadMemberRow(db, actor, req.body.memberId, 'read');
    const id = await db.transaction().execute(async (tx) => {
      const o = await tx.insertInto('offer').values({ organization_id: actor.organizationId, member_id: row.id, person_id: row.person_id, valid_until: req.body.validUntil ?? null, cover_text: req.body.coverText ?? null, closing_text: req.body.closingText ?? null, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await writeLines(tx, actor.organizationId, o.id, req.body.lines);
      await audit(tx, actor.organizationId, actor, { action: 'offer.created', entityType: 'offer', entityId: o.id });
      return o.id;
    });
    reply.status(201);
    return dto(actor, id);
  });

  app.patch('/offers/:id', { schema: { tags, summary: 'Entwurf ändern', params: idParam, body: offerPatch, response: { 200: offer } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const o = await loadDraft(actor, req.params.id);
    if (o.status !== 'draft') throw new Problem(409, 'not-draft', 'Ein verschicktes Angebot ändert sich nicht mehr.', 'Leg ein neues Angebot an.');
    await db.transaction().execute(async (tx) => {
      const b = req.body;
      await tx.updateTable('offer').set({
        ...(b.validUntil !== undefined ? { valid_until: b.validUntil } : {}),
        ...(b.coverText !== undefined ? { cover_text: b.coverText } : {}),
        ...(b.closingText !== undefined ? { closing_text: b.closingText } : {}),
        updated_at: new Date(),
      }).where('id', '=', o.id).execute();
      if (b.lines) await writeLines(tx, actor.organizationId, o.id, b.lines);
      await audit(tx, actor.organizationId, actor, { action: 'offer.updated', entityType: 'offer', entityId: o.id });
    });
    return dto(actor, o.id);
  });

  app.delete('/offers/:id', { schema: { tags, summary: 'Entwurf löschen', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const o = await loadDraft(actor, req.params.id);
    if (o.status !== 'draft') throw new Problem(409, 'not-draft', 'Ein verschicktes Angebot bleibt erhalten.');
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('offer').where('id', '=', o.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'offer.deleted', entityType: 'offer', entityId: o.id });
    });
    return reply.status(204).send();
  });

  app.post('/offers/:id/issue', { schema: { tags, summary: 'Angebot ausstellen: Nummer, Datum, Gültigkeit (Standard 30 Tage); das PDF wird gespeichert', params: idParam, body: z.object({ issueDate: z.iso.date().optional() }).optional(), response: { 200: offer } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    await db.transaction().execute(async (tx) => {
      const o = await tx.selectFrom('offer').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!o) throw notFound('Angebot');
      if (o.status !== 'draft') throw new Problem(409, 'not-draft', 'Das Angebot ist bereits ausgestellt.');
      const issueDate = req.body?.issueDate ?? (await orgToday(tx, actor.organizationId));
      const validUntil = o.valid_until ?? addDays(issueDate, 30);
      if (validUntil < issueDate) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'validUntil', message: 'Die Gültigkeit endet vor dem Angebotsdatum.' }] });
      const org = await tx.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
      const person = await tx.selectFrom('person').selectAll().where('id', '=', o.person_id).executeTakeFirstOrThrow();
      const member = await tx.selectFrom('member').select('membership_number').where('id', '=', o.member_id).executeTakeFirstOrThrow();
      const lines = await tx.selectFrom('offer_line').selectAll().where('offer_id', '=', o.id).orderBy('position').execute();
      const taken = async (n: string) => !!(await tx.selectFrom('offer').select('id').where('organization_id', '=', actor.organizationId).where('number', '=', n).executeTakeFirst());
      const number = await nextNumber(tx, actor.organizationId, 'offer', org.offer_number_pattern, issueDate, taken);
      const recipient = personLines(person);
      const pdf = await renderInvoicePdf({
        title: 'Angebot', number, issueDate, dueDate: null, membershipNumber: member.membership_number, recipientLines: recipient.lines,
        coverText: o.cover_text, closingText: o.closing_text,
        lines: lines.map((l) => ({ text: l.text, quantity: Number(l.quantity), unitCents: Number(l.unit_cents), totalCents: Number(l.total_cents), taxRate: Number(l.tax_rate) })),
        totalCents: Number(o.total_cents), negative: false,
        paymentText: `Dieses Angebot gilt bis zum ${formatDate(validUntil)}. Sag uns gern Bescheid, wenn es passt; die Rechnung folgt dann gesondert.`,
        epc: null,
        org: { name: org.name, street: org.street, postalCode: org.postal_code, city: org.city, email: org.email, iban: org.iban, bic: org.bic, bankName: org.bank_name },
        demo: org.is_demo,
      });
      await tx.updateTable('offer').set({ number, status: 'sent', issue_date: issueDate, valid_until: validUntil, recipient: JSON.stringify(recipient), pdf, updated_at: new Date() }).where('id', '=', o.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'offer.issued', entityType: 'offer', entityId: o.id, diff: { number: [null, number] } });
    });
    return dto(actor, req.params.id);
  });

  app.get('/offers/:id/pdf', { schema: { tags, summary: 'Angebot als PDF (gespeichert beim Ausstellen)', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'read');
    const o = await db.selectFrom('offer').select(['number', 'pdf']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!o?.pdf) throw notFound('Angebot');
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${o.number}.pdf"`).header('cache-control', 'private, no-store').send(o.pdf);
  });

  for (const [path, status] of [['accept', 'accepted'], ['decline', 'declined']] as const) {
    app.post(`/offers/:id/${path}`, { schema: { tags, summary: status === 'accepted' ? 'Als angenommen markieren' : 'Als abgelehnt markieren', params: idParam, body: z.object({}).optional(), response: { 200: offer } } }, async (req) => {
      const actor = requireActor(req);
      requireClubWide(actor, 'invoices', 'write');
      await db.transaction().execute(async (tx) => {
        const r = await tx.updateTable('offer').set({ status, updated_at: new Date() }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where('status', 'in', status === 'accepted' ? ['sent', 'declined'] : ['sent', 'accepted']).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new Problem(409, 'offer-state', 'Das geht nur bei einem verschickten Angebot.');
        await audit(tx, actor.organizationId, actor, { action: `offer.${status}`, entityType: 'offer', entityId: req.params.id });
      });
      return dto(actor, req.params.id);
    });
  }

  app.post('/offers/:id/convert', { schema: { tags, summary: 'Aus dem Angebot einen Rechnungsentwurf machen (einmal)', params: idParam, body: z.object({}).optional(), response: { 201: z.object({ invoiceId: z.uuid() }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'invoices', 'write');
    const invoiceId = await db.transaction().execute(async (tx) => {
      const o = await tx.selectFrom('offer').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!o) throw notFound('Angebot');
      if (!['sent', 'accepted'].includes(o.status)) throw new Problem(409, 'offer-state', o.status === 'converted' ? 'Aus diesem Angebot gibt es schon eine Rechnung.' : 'Nur ein verschicktes oder angenommenes Angebot wird zur Rechnung.');
      const lines = await tx.selectFrom('offer_line').selectAll().where('offer_id', '=', o.id).orderBy('position').execute();
      const inv = await createDraft(tx, { organizationId: actor.organizationId, kind: 'other', personId: o.person_id, memberId: o.member_id, coverText: `Zu unserem Angebot ${o.number}.`, createdBy: actor.userId },
        lines.map((l) => ({ text: l.text, quantity: Number(l.quantity), unitCents: Number(l.unit_cents), taxRate: Number(l.tax_rate) })));
      await tx.updateTable('offer').set({ status: 'converted', invoice_id: inv, updated_at: new Date() }).where('id', '=', o.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'offer.converted', entityType: 'offer', entityId: o.id, diff: { invoiceId: [null, inv] } });
      return inv;
    });
    reply.status(201);
    return { invoiceId };
  });
};
