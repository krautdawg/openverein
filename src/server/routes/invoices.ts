import { PDFDocument } from 'pdf-lib';
import { decryptBytes } from '../crypto.ts';
import { assertIfMatch, setETag, versionOf } from '../http/concurrency.ts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { addDays } from '../../shared/dates.ts';
import { allocationDto, dunningProposal, invoiceCreate, invoiceDetail, invoiceListItem, invoicePatch, invoiceQuery, paymentInput, type InvoiceListItem } from '../../shared/invoices.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db, DunningLevel, InvoiceKind, InvoiceStatus } from '../db.ts';
import { forbidden, notFound, Problem } from '../http/problem.ts';
import { cancelInvoice, createDraft, DUNNABLE_KINDS, insertLines, issueInvoice, RECEIVABLE_KINDS, refreshPayment, storedPdf, type IssueSnapshot } from '../invoices/service.ts';
import { loadMemberRow, orgToday, scopePredicate } from '../members/query.ts';
import { assertNotLive } from '../sepa/live.ts';
import { requirePermission, restrictedFields, scopeOf, type Actor } from '../policy.ts';

const idParam = z.object({ id: z.uuid() });
const tags = ['invoices'];

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  /** Base query: invoices of the organisation; scoped actors see only invoices of members in scope. */
  function base(actor: Actor, today: string) {
    let q = db
      .selectFrom('invoice')
      .innerJoin('person', 'person.id', 'invoice.recipient_person_id')
      .leftJoin('member', 'member.id', 'invoice.member_id')
      .where('invoice.organization_id', '=', actor.organizationId);
    const scope = scopeOf(actor, 'invoices', 'read');
    if (scope !== null) q = q.where(scopePredicate(scope, today, 'read'));
    return q;
  }

  const listColumns = [
    'invoice.id',
    'invoice.number',
    'invoice.kind',
    'invoice.status',
    'invoice.member_id',
    'invoice.issue_date',
    'invoice.due_date',
    'invoice.total_cents',
    'invoice.paid_cents',
    'invoice.recipient',
    'person.kind as person_kind',
    'person.first_name',
    'person.last_name',
    'person.company_name',
  ] as const;

  type ListRow = {
    id: string; number: string | null; kind: InvoiceKind; status: InvoiceStatus; member_id: string | null; issue_date: string | null; due_date: string | null;
    total_cents: number; paid_cents: number; recipient: unknown; person_kind: string; first_name: string | null; last_name: string | null; company_name: string | null;
  };

  async function toItems(rows: ListRow[], today: string): Promise<InvoiceListItem[]> {
    const levels = rows.length
      ? await db.selectFrom('dunning_event').select(['invoice_id', sql<number>`max(level)::int`.as('level')]).where('invoice_id', 'in', rows.map((r) => r.id)).groupBy('invoice_id').execute()
      : [];
    return rows.map((r) => {
      const snap = r.recipient as IssueSnapshot | null;
      const name = snap?.recipient.name ?? (r.person_kind === 'organisation' ? r.company_name ?? '' : [r.first_name, r.last_name].filter(Boolean).join(' '));
      const open = ['open', 'partially_paid'].includes(r.status) ? r.total_cents - r.paid_cents : 0;
      return {
        id: r.id,
        number: r.number,
        kind: r.kind,
        status: r.status,
        recipientName: name,
        memberId: r.member_id,
        issueDate: r.issue_date,
        dueDate: r.due_date,
        totalCents: r.total_cents,
        openCents: open,
        overdue: open > 0 && RECEIVABLE_KINDS.includes(r.kind) && !!r.due_date && r.due_date < today,
        dunningLevel: levels.find((l) => l.invoice_id === r.id)?.level ?? 0,
      };
    });
  }

  async function detail(actor: Actor, id: string) {
    const today = await orgToday(db, actor.organizationId);
    const row = await base(actor, today).select([...listColumns, 'invoice.updated_at', 'invoice.cover_text', 'invoice.cancels_invoice_id', 'invoice.pdf_sha256', 'invoice.written_off_reason', 'invoice.dunning_hold_until', 'invoice.dunning_hold_reason']).where('invoice.id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Rechnung');
    const [item] = await toItems([row], today);
    const lines = await db
      .selectFrom('invoice_line')
      .leftJoin('assessment', 'assessment.id', 'invoice_line.assessment_id')
      .select(['invoice_line.id', 'invoice_line.position', 'invoice_line.text', 'invoice_line.quantity', 'invoice_line.unit_cents', 'invoice_line.total_cents', 'invoice_line.tax_rate', 'assessment.period_start', 'assessment.period_end'])
      .where('invoice_line.invoice_id', '=', id)
      .orderBy('invoice_line.position')
      .execute();
    const allocations = await db.selectFrom('allocation').selectAll().where('invoice_id', '=', id).orderBy('created_at').execute();
    const dunning = await db.selectFrom('dunning_event').selectAll().where('invoice_id', '=', id).orderBy('level').execute();
    const cancels = row.cancels_invoice_id ? await db.selectFrom('invoice').select(['id', 'number']).where('id', '=', row.cancels_invoice_id).executeTakeFirst() : undefined;
    const cancelledBy = await db.selectFrom('invoice').select(['id', 'number']).where('cancels_invoice_id', '=', id).executeTakeFirst();
    const snap = row.recipient as IssueSnapshot | null;
    return {
      ...item!,
      version: versionOf(row.updated_at as Date),
      hasEinvoice: !!(await db.selectFrom('invoice_einvoice').select('invoice_id').where('invoice_id', '=', id).executeTakeFirst()),
      coverText: row.cover_text,
      recipient: snap?.recipient ?? null,
      lines: lines.map((l) => ({ id: l.id, position: l.position, text: l.text, quantity: Number(l.quantity), unitCents: l.unit_cents, totalCents: l.total_cents, taxRate: Number(l.tax_rate), periodStart: l.period_start, periodEnd: l.period_end })),
      allocations: allocations.map((a) => ({ id: a.id, amountCents: a.amount_cents, bookedOn: a.booked_on, method: a.method, note: a.note, status: a.status })),
      dunning: dunning.map((d) => ({ level: d.level, label: d.label, feeCents: d.fee_cents, at: d.created_at.toISOString(), feeInvoiceId: d.fee_invoice_id })),
      cancelsInvoice: cancels ?? null,
      cancelledBy: cancelledBy ?? null,
      pdfSha256: row.pdf_sha256,
      writtenOffReason: row.written_off_reason,
      dunningHoldUntil: row.dunning_hold_until,
      dunningHoldReason: row.dunning_hold_reason,
    };
  }

  async function loadForWrite(tx: Db, actor: Actor, id: string) {
    const inv = await tx.selectFrom('invoice').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
    if (!inv) throw notFound('Rechnung');
    if (inv.member_id) await loadMemberRow(tx, actor, inv.member_id, 'write', 'invoices');
    return inv;
  }

  app.get('/invoices', { schema: { tags, summary: 'Rechnungen suchen und filtern', querystring: invoiceQuery, response: { 200: z.object({ items: z.array(invoiceListItem), total: z.number(), nextCursor: z.string().nullable(), sums: z.object({ totalCents: z.number(), openCents: z.number() }) }) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'read');
    const today = await orgToday(db, actor.organizationId);
    const f = req.query;
    const filtered = () => {
      let q = base(actor, today);
      if (f.status === 'open') q = q.where('invoice.status', 'in', ['open', 'partially_paid']);
      else if (f.status === 'overdue') q = q.where('invoice.status', 'in', ['open', 'partially_paid']).where('invoice.due_date', '<', today).where('invoice.kind', 'in', RECEIVABLE_KINDS);
      else if (f.status !== 'all') q = q.where('invoice.status', '=', f.status);
      if (f.memberId) q = q.where('invoice.member_id', '=', f.memberId);
      if (f.feeRunId) q = q.where('invoice.fee_run_id', '=', f.feeRunId);
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c)}%`;
        q = q.where((eb) => eb.or([eb(sql`lower(invoice.number)`, 'like', like), eb(sql`lower(unaccent(coalesce(person.last_name, '') || ' ' || coalesce(person.first_name, '') || ' ' || coalesce(person.company_name, '')))`, 'like', sql<string>`lower(unaccent(${like}))`)]));
      }
      return q;
    };
    const raw = f.cursor ? Buffer.from(f.cursor, 'base64url').toString() : '0';
    const offset = /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
    const rows = await filtered().select(listColumns).orderBy(sql`invoice.status = 'draft'`, 'desc').orderBy('invoice.issue_date', (ob) => ob.desc().nullsFirst()).orderBy('invoice.number', 'desc').limit(f.limit).offset(offset).execute();
    const agg = await filtered()
      // Sums count receivables only: cancelled originals, cancellation documents and credit notes would distort them.
      .select([
        sql<number>`count(*)::int`.as('n'),
        sql<number>`coalesce(sum(invoice.total_cents) filter (where invoice.kind in ('membership','other','dunning_fee') and invoice.status not in ('draft','cancelled')), 0)::bigint`.as('total'),
        sql<number>`coalesce(sum(invoice.total_cents - invoice.paid_cents) filter (where invoice.kind in ('membership','other','dunning_fee') and invoice.status in ('open','partially_paid')), 0)::bigint`.as('open'),
      ])
      .executeTakeFirstOrThrow();
    return {
      items: await toItems(rows, today),
      total: agg.n,
      nextCursor: offset + rows.length < agg.n ? Buffer.from(String(offset + rows.length)).toString('base64url') : null,
      sums: { totalCents: agg.total, openCents: agg.open },
    };
  });

  app.get('/invoices/:id', { schema: { tags, summary: 'Rechnung mit Positionen, Zahlungen und Mahnungen (ETag für If-Match bei Entwürfen)', params: idParam, response: { 200: invoiceDetail } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'read');
    const d = await detail(actor, req.params.id);
    setETag(reply, d.version);
    return d;
  });

  app.get('/invoices/:id/pdf', { schema: { tags, summary: 'PDF der ausgestellten Rechnung (immer dieselben Bytes)', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'read');
    await detail(actor, req.params.id); // scope check
    const { pdf, number } = await storedPdf(db, actor.organizationId, req.params.id);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${number}.pdf"`).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(pdf);
  });

  app.post('/invoices/letters.pdf', { schema: { tags, summary: 'Briefe drucken: ausgestellte Rechnungen als ein PDF, nach Postleitzahl sortiert und für Duplexdruck auf gerade Seitenzahlen aufgefüllt', body: z.object({ invoiceIds: z.array(z.uuid()).min(1).max(500) }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'read');
    const letters: { pdf: Buffer; number: string; postalCode: string }[] = [];
    for (const id of new Set(req.body.invoiceIds)) {
      await detail(actor, id); // scope check
      const { pdf, number } = await storedPdf(db, actor.organizationId, id);
      const snap = (await db.selectFrom('invoice').select('recipient').where('id', '=', id).executeTakeFirstOrThrow()).recipient as IssueSnapshot;
      // Sorted by postal code for the post's bulk rates; addresses without one go last.
      letters.push({ pdf, number, postalCode: snap.recipient.lines.join(' ').match(/\b\d{5}\b/)?.[0] ?? '99999z' });
    }
    letters.sort((a, b) => a.postalCode.localeCompare(b.postalCode) || a.number.localeCompare(b.number));
    const out = await PDFDocument.create();
    for (const l of letters) {
      const src = await PDFDocument.load(l.pdf);
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      // Duplex: every letter starts on a front page.
      if (src.getPageCount() % 2) out.addPage([595.28, 841.89]);
    }
    await audit(db, actor.organizationId, actor, { action: 'invoice.letters_printed', entityType: 'invoice', entityId: req.body.invoiceIds[0]!, diff: { numbers: [null, letters.map((l) => l.number)] } });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="Briefe-${new Date().toISOString().slice(0, 10)}.pdf"`).header('cache-control', 'private, no-store').send(Buffer.from(await out.save()));
  });

  app.get('/invoices/:id/xrechnung.xml', { schema: { tags, summary: 'E-Rechnung (XRechnung, CII) der ausgestellten Rechnung, unverändert wie bei der Ausstellung erzeugt', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'read');
    await detail(actor, req.params.id); // scope check
    // A direct-debit e-invoice carries the full IBAN: only for roles that may see IBANs.
    if (restrictedFields(actor).has('iban')) throw forbidden('members.field.iban');
    const e = await db.selectFrom('invoice_einvoice').innerJoin('invoice', 'invoice.id', 'invoice_einvoice.invoice_id').select(['invoice_einvoice.xml', 'invoice.number']).where('invoice_einvoice.invoice_id', '=', req.params.id).where('invoice_einvoice.organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!e) throw notFound('E-Rechnung');
    return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${e.number}.xml"`).header('cache-control', 'private, no-store').send(decryptBytes(e.xml));
  });

  app.post('/invoices', { schema: { tags, summary: 'Rechnungsentwurf anlegen', body: invoiceCreate, response: { 201: invoiceDetail } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    const { row } = await loadMemberRow(db, actor, req.body.memberId, 'write', 'invoices');
    const id = await db.transaction().execute(async (tx) => {
      const id = await createDraft(tx, { organizationId: actor.organizationId, kind: req.body.kind, personId: row.person_id, memberId: row.id, dueDate: req.body.dueDate, coverText: req.body.coverText, createdBy: actor.userId }, req.body.lines);
      await audit(tx, actor.organizationId, actor, { action: 'invoice.drafted', entityType: 'invoice', entityId: id });
      return id;
    });
    reply.status(201);
    return detail(actor, id);
  });

  app.patch('/invoices/:id', { schema: { tags, summary: 'Entwurf ändern (ausgestellte Rechnungen sind unveränderlich)', params: idParam, body: invoicePatch, response: { 200: invoiceDetail } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    await db.transaction().execute(async (tx) => {
      const inv = await loadForWrite(tx, actor, req.params.id);
      if (inv.status !== 'draft') throw new Problem(409, 'immutable', 'Ausgestellte Rechnungen lassen sich nicht ändern. Erstelle eine Stornorechnung.');
      assertIfMatch(req, versionOf(inv.updated_at as Date));
      await tx.updateTable('invoice').set({ ...(req.body.kind ? { kind: req.body.kind } : {}), ...(req.body.dueDate !== undefined ? { due_date: req.body.dueDate } : {}), ...(req.body.coverText !== undefined ? { cover_text: req.body.coverText } : {}), updated_at: new Date() }).where('id', '=', inv.id).execute();
      if (req.body.lines) {
        await tx.deleteFrom('invoice_line').where('invoice_id', '=', inv.id).execute();
        await insertLines(tx, actor.organizationId, inv.id, req.body.lines);
      }
      await audit(tx, actor.organizationId, actor, { action: 'invoice.draft_updated', entityType: 'invoice', entityId: inv.id });
    });
    return detail(actor, req.params.id);
  });

  app.delete('/invoices/:id', { schema: { tags, summary: 'Entwurf löschen', params: idParam, body: z.object({}).optional(), response: { 204: z.null() } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    await db.transaction().execute(async (tx) => {
      const inv = await loadForWrite(tx, actor, req.params.id);
      if (inv.status !== 'draft') throw new Problem(409, 'immutable', 'Nur Entwürfe lassen sich löschen.');
      await tx.deleteFrom('invoice').where('id', '=', inv.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'invoice.draft_deleted', entityType: 'invoice', entityId: inv.id });
    });
    reply.status(204);
    return null;
  });

  app.post('/invoices/:id/issue', { schema: { tags, summary: 'Entwurf ausstellen: fortlaufende Nummer, danach unveränderlich', params: idParam, body: z.object({ issueDate: z.iso.date().optional() }).optional(), response: { 200: invoiceDetail } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    const today = await orgToday(db, actor.organizationId);
    await db.transaction().execute(async (tx) => {
      const inv = await loadForWrite(tx, actor, req.params.id);
      const r = await issueInvoice(tx, actor.organizationId, inv.id, req.body?.issueDate ?? today);
      await audit(tx, actor.organizationId, actor, { action: 'invoice.issued', entityType: 'invoice', entityId: inv.id, diff: { number: [null, r.number], totalCents: [null, r.total] } });
    });
    return detail(actor, req.params.id);
  });

  app.post('/invoices/:id/cancel', { schema: { tags, summary: 'Rechnung mit Stornorechnung aufheben', params: idParam, body: z.object({}).optional(), response: { 200: invoiceDetail } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    const today = await orgToday(db, actor.organizationId);
    await db.transaction().execute(async (tx) => {
      const inv = await loadForWrite(tx, actor, req.params.id);
      const r = await cancelInvoice(tx, actor.organizationId, inv.id, today, actor.userId);
      await audit(tx, actor.organizationId, actor, { action: 'invoice.cancelled', entityType: 'invoice', entityId: inv.id, diff: { cancellation: [null, r.number] } });
    });
    return detail(actor, req.params.id);
  });

  app.post('/invoices/:id/payments', { schema: { tags, summary: 'Zahlungseingang von Hand erfassen (bar, Überweisung)', params: idParam, body: paymentInput, response: { 201: invoiceDetail } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    await db.transaction().execute(async (tx) => {
      const inv = await loadForWrite(tx, actor, req.params.id);
      if (!['open', 'partially_paid'].includes(inv.status)) throw new Problem(409, 'not-open', 'Auf diese Rechnung kann nichts mehr gebucht werden.');
      await assertNotLive(tx, inv.id);
      const open = inv.total_cents - inv.paid_cents;
      if (req.body.amountCents > open) {
        throw new Problem(400, 'overpayment', 'Der Betrag ist höher als der offene Betrag.', `Offen sind ${(open / 100).toFixed(2).replace('.', ',')} €.`, { errors: [{ field: 'amountCents', message: 'Höher als der offene Betrag.' }] });
      }
      const a = await tx.insertInto('allocation').values({ organization_id: actor.organizationId, invoice_id: inv.id, amount_cents: req.body.amountCents, booked_on: req.body.bookedOn, method: req.body.method, note: req.body.note ?? null, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await refreshPayment(tx, inv.id);
      await audit(tx, actor.organizationId, actor, { action: 'invoice.payment', entityType: 'invoice', entityId: inv.id, diff: { allocation: [null, a.id], amountCents: [null, req.body.amountCents] } });
    });
    reply.status(201);
    return detail(actor, req.params.id);
  });

  app.post('/allocations/:id/reverse', { schema: { tags, summary: 'Zahlung oder Ausbuchung zurücknehmen', params: idParam, body: z.object({}).optional(), response: { 200: allocationDto } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    const a = await db.transaction().execute(async (tx) => {
      const a = await tx.selectFrom('allocation').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!a) throw notFound('Zahlung');
      await loadForWrite(tx, actor, a.invoice_id);
      if (a.status === 'reversed') throw new Problem(409, 'already-reversed', 'Die Zahlung ist bereits zurückgenommen.');
      const r = await tx.updateTable('allocation').set({ status: 'reversed', reversed_at: new Date() }).where('id', '=', a.id).returningAll().executeTakeFirstOrThrow();
      if (a.method === 'write_off') await tx.updateTable('invoice').set({ status: 'open', written_off_reason: null }).where('id', '=', a.invoice_id).execute();
      await refreshPayment(tx, a.invoice_id);
      await audit(tx, actor.organizationId, actor, { action: 'invoice.payment_reversed', entityType: 'invoice', entityId: a.invoice_id, diff: { allocation: [a.id, null], amountCents: [a.amount_cents, 0] } });
      return r;
    });
    return { id: a.id, amountCents: a.amount_cents, bookedOn: a.booked_on, method: a.method, note: a.note, status: a.status };
  });

  app.post('/invoices/:id/write-off', { schema: { tags, summary: 'Offenen Betrag als uneinbringlich ausbuchen', params: idParam, body: z.object({ reason: z.string().trim().min(3, 'Bitte gib einen Grund an.').max(300) }), response: { 200: invoiceDetail } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'write');
    const today = await orgToday(db, actor.organizationId);
    await db.transaction().execute(async (tx) => {
      const inv = await loadForWrite(tx, actor, req.params.id);
      if (!['open', 'partially_paid'].includes(inv.status) || !RECEIVABLE_KINDS.includes(inv.kind)) throw new Problem(409, 'not-open', 'Nur offene Forderungen lassen sich ausbuchen.');
      await assertNotLive(tx, inv.id);
      const open = inv.total_cents - inv.paid_cents;
      await tx.insertInto('allocation').values({ organization_id: actor.organizationId, invoice_id: inv.id, amount_cents: open, booked_on: today, method: 'write_off', note: req.body.reason, created_by: actor.userId }).execute();
      await tx.updateTable('invoice').set({ written_off_reason: req.body.reason }).where('id', '=', inv.id).execute();
      await refreshPayment(tx, inv.id);
      await audit(tx, actor.organizationId, actor, { action: 'invoice.written_off', entityType: 'invoice', entityId: inv.id, diff: { openCents: [open, 0], reason: [null, req.body.reason] } });
    });
    return detail(actor, req.params.id);
  });

  // ---------- Dunning ----------

  app.get('/dunning/proposal', { schema: { tags, summary: 'Rechnungen, die die nächste Mahnstufe erreicht haben', response: { 200: z.array(dunningProposal) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'invoices', 'read');
    const today = await orgToday(db, actor.organizationId);
    const org = await db.selectFrom('organization').select('dunning_levels').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const levels = [...org.dunning_levels].sort((a, b) => a.level - b.level);
    const rows = await base(actor, today)
      .select(listColumns)
      .where('invoice.status', 'in', ['open', 'partially_paid'])
      .where('invoice.kind', 'in', DUNNABLE_KINDS)
      .where('invoice.due_date', '<', today)
      .where((eb) => eb.or([eb('invoice.dunning_hold_until', 'is', null), eb('invoice.dunning_hold_until', '<', today)]))
      .orderBy('invoice.due_date')
      .execute();
    const items = await toItems(rows, today);
    const out: z.infer<typeof dunningProposal>[] = [];
    for (const it of items) {
      const next = levels.find((l) => l.level > it.dunningLevel);
      if (!next || !it.dueDate) continue;
      const daysOverdue = Math.round((Date.parse(today) - Date.parse(it.dueDate)) / 86_400_000);
      if (daysOverdue >= next.days) out.push({ invoice: it, nextLevel: next.level, label: next.label, feeCents: next.feeCents, daysOverdue });
    }
    return out;
  });

  app.post(
    '/invoices/:id/dunning',
    { schema: { tags, summary: 'Mahnstufe anwenden (Mahngebühr als eigene Rechnung). Versand ist ein eigener Schritt.', params: idParam, body: z.object({ level: z.number().int().min(1).max(9) }), response: { 200: invoiceDetail } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'invoices', 'write');
      const today = await orgToday(db, actor.organizationId);
      await db.transaction().execute(async (tx) => {
        const inv = await loadForWrite(tx, actor, req.params.id);
        if (!['open', 'partially_paid'].includes(inv.status) || !DUNNABLE_KINDS.includes(inv.kind)) throw new Problem(409, 'not-open', 'Nur offene Forderungen lassen sich mahnen.');
        const org = await tx.selectFrom('organization').select(['dunning_levels', 'payment_terms_days']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
        const levels = [...(org.dunning_levels as DunningLevel[])].sort((a, b) => a.level - b.level);
        const done = await tx.selectFrom('dunning_event').select(sql<number>`coalesce(max(level), 0)::int`.as('max')).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();
        // Same rules as the proposal: the next level only, once it is due, and never during a hold.
        const level = levels.find((l) => l.level > done.max);
        if (!level || level.level !== req.body.level) throw new Problem(409, 'wrong-level', level ? `Als Nächstes ist Stufe ${level.level} dran.` : 'Alle Mahnstufen sind schon angewendet.');
        const overdue = inv.due_date ? Math.round((Date.parse(today) - Date.parse(inv.due_date)) / 86_400_000) : -1;
        if (overdue < level.days) throw new Problem(409, 'not-due', `Diese Stufe ist erst ${level.days} Tage nach Fälligkeit möglich.`);
        if (inv.dunning_hold_until && inv.dunning_hold_until >= today) throw new Problem(409, 'on-hold', 'Für diese Rechnung gilt eine Mahnpause.');
        let feeInvoiceId: string | null = null;
        if (level.feeCents > 0) {
          feeInvoiceId = await createDraft(
            tx,
            { organizationId: actor.organizationId, kind: 'dunning_fee', personId: inv.recipient_person_id, memberId: inv.member_id, dueDate: addDays(today, org.payment_terms_days), createdBy: actor.userId },
            [{ text: `${level.label} zu Rechnung ${inv.number}`, quantity: 1, unitCents: level.feeCents, taxRate: 0 }],
          );
          await issueInvoice(tx, actor.organizationId, feeInvoiceId, today);
        }
        await tx.insertInto('dunning_event').values({ organization_id: actor.organizationId, invoice_id: inv.id, level: level.level, label: level.label, fee_cents: level.feeCents, fee_invoice_id: feeInvoiceId, created_by: actor.userId }).execute();
        await audit(tx, actor.organizationId, actor, { action: 'invoice.dunning', entityType: 'invoice', entityId: inv.id, diff: { level: [done.max, level.level], feeCents: [null, level.feeCents] } });
      });
      return detail(actor, req.params.id);
    },
  );

  app.post(
    '/invoices/:id/dunning-hold',
    { schema: { tags, summary: 'Mahnungen bis zu einem Datum aussetzen (z. B. Ratenzahlung)', params: idParam, body: z.object({ until: z.iso.date().nullable(), reason: z.string().trim().max(200).nullish() }), response: { 200: invoiceDetail } } },
    async (req) => {
      const actor = requireActor(req);
      requirePermission(actor, 'invoices', 'write');
      await db.transaction().execute(async (tx) => {
        const inv = await loadForWrite(tx, actor, req.params.id);
        if (req.body.until && !req.body.reason) throw new Problem(400, 'validation', 'Bitte gib einen Grund an.', undefined, { errors: [{ field: 'reason', message: 'Bitte gib einen Grund an.' }] });
        await tx.updateTable('invoice').set({ dunning_hold_until: req.body.until, dunning_hold_reason: req.body.until ? (req.body.reason ?? null) : null }).where('id', '=', inv.id).execute();
        await audit(tx, actor.organizationId, actor, { action: 'invoice.dunning_hold', entityType: 'invoice', entityId: inv.id, diff: { until: [inv.dunning_hold_until, req.body.until] } });
      });
      return detail(actor, req.params.id);
    },
  );
};
