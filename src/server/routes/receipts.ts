import { createRequire } from 'node:module';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import { z } from 'zod';
import { formatDate } from '../../shared/dates.ts';
import { MAX_FILE_BYTES } from '../../shared/documents.ts';
import { cashBook, receipt, receiptInput, selfIssuedInput } from '../../shared/receipts.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { getBlob, putBlob, sha256Of } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { assertCashNotNegative, bookingLines, lockJournal, postEntry, reverseEntry } from '../ledger/service.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide, type Actor } from '../policy.ts';

const tags = ['ledger'];
const idParam = z.object({ id: z.uuid() });
const require = createRequire(import.meta.url);
const FONT = require.resolve('source-sans/TTF/SourceSans3-Regular.ttf');
const FONT_BOLD = require.resolve('source-sans/TTF/SourceSans3-Semibold.ttf');
// Vouchers are kept eight years after the end of the year (§ 147 AO).
const addYears = (date: string, n: number) => `${Number(date.slice(0, 4)) + n}${date.slice(4)}`;
const money = (c: number) => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

function pdf(build: (doc: PDFKit.PDFDocument) => void, title: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  build(doc);
  doc.end();
  return done;
}

export const receiptRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES }, (_req, body, done) => done(null, body));

  async function dto(organizationId: string, ids?: string[], filter: { year?: number; status?: string } = {}) {
    let q = db.selectFrom('receipt').leftJoin('journal_entry', 'journal_entry.id', 'receipt.journal_entry_id').selectAll('receipt').select('journal_entry.number as journal').where('receipt.organization_id', '=', organizationId);
    if (ids) q = q.where('receipt.id', 'in', ids);
    if (filter.year) q = q.where('receipt.receipt_date', '>=', `${filter.year}-01-01`).where('receipt.receipt_date', '<=', `${filter.year}-12-31`);
    if (filter.status) q = q.where('receipt.status', '=', filter.status as 'open');
    const rows = await q.orderBy('receipt.receipt_date', 'desc').orderBy('receipt.created_at', 'desc').limit(1000).execute();
    if (!rows.length) return [];
    const lines = await db.selectFrom('receipt_line').innerJoin('ledger_account', 'ledger_account.id', 'receipt_line.account_id').leftJoin('tax_rate', 'tax_rate.id', 'receipt_line.tax_rate_id').select(['receipt_line.receipt_id', 'receipt_line.text', 'receipt_line.gross_cents', 'ledger_account.number', 'ledger_account.name', 'tax_rate.label']).where('receipt_line.receipt_id', 'in', rows.map((r) => r.id)).orderBy('receipt_line.position').execute();
    return rows.map((r) => ({
      id: r.id, supplier: r.supplier, number: r.number, receiptDate: r.receipt_date, dueDate: r.due_date, status: r.status, totalCents: Number(r.total_cents), selfIssued: r.self_issued, hasFile: !!r.file_id,
      paidOn: r.paid_on, journalNumber: r.journal ?? null, note: r.note, voidReason: r.void_reason,
      lines: lines.filter((l) => l.receipt_id === r.id).map((l) => ({ text: l.text, grossCents: Number(l.gross_cents), accountNumber: l.number, accountName: l.name, taxRate: l.label })),
    }));
  }

  /** Posts a receipt's payment: expense lines against the money account, under the journal lock with the cash check. */
  async function pay(tx: Db, actor: Actor, id: string, p: { date: string; moneyAccountId: string }) {
    const r = await tx.selectFrom('receipt').selectAll().where('id', '=', id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
    if (!r) throw notFound('Beleg');
    if (r.status !== 'open') throw new Problem(409, 'not-open', 'Dieser Beleg ist nicht mehr offen.');
    const today = await orgToday(tx, actor.organizationId);
    if (p.date > today) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'pay.date', message: 'Das Zahldatum liegt in der Zukunft.' }] });
    const lines = await tx.selectFrom('receipt_line').selectAll().where('receipt_id', '=', r.id).orderBy('position').execute();
    await lockJournal(tx, actor.organizationId);
    const b = await bookingLines(tx, actor.organizationId, { kind: 'expense', date: p.date, moneyAccountId: p.moneyAccountId, lines: lines.map((l) => ({ grossCents: Number(l.gross_cents), accountId: l.account_id, taxRateId: l.tax_rate_id, sphere: l.sphere, costCenterId: l.cost_center_id, text: l.text })) });
    const settings = await tx.selectFrom('ledger_setting').select('cash_account_id').where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (b.money.id === settings?.cash_account_id) await assertCashNotNegative(tx, actor.organizationId, b.money.id, p.date, -b.total);
    const e = await postEntry(tx, actor.organizationId, { date: p.date, text: `${r.supplier}${r.number ? ` ${r.number}` : ''}`, source: 'receipt', sourceId: r.id, createdBy: actor.userId, lines: b.lines });
    await tx.updateTable('receipt').set({ status: 'paid', paid_on: p.date, money_account_id: b.money.id, journal_entry_id: e.id, updated_at: new Date() }).where('id', '=', r.id).execute();
    await audit(tx, actor.organizationId, actor, { action: 'receipt.paid', entityType: 'receipt', entityId: r.id, diff: { paidOn: [null, p.date], journal: [null, e.number] } });
  }

  async function warningsFor(tx: Db, organizationId: string, r: { id?: string; supplier: string; number?: string | null; fileId?: string | null }) {
    const out: string[] = [];
    if (r.number) {
      const same = await tx.selectFrom('receipt').select(['receipt_date']).where('organization_id', '=', organizationId).where(sql`lower(supplier)`, '=', r.supplier.toLowerCase()).where('number', '=', r.number).where('status', '<>', 'void').$if(!!r.id, (q) => q.where('id', '<>', r.id!)).executeTakeFirst();
      if (same) out.push(`Von ${r.supplier} gibt es schon einen Beleg mit der Nummer ${r.number} (${formatDate(same.receipt_date)}).`);
    }
    if (r.fileId) {
      const dup = await tx.selectFrom('receipt').innerJoin('file', 'file.id', 'receipt.file_id').innerJoin('file as mine', (j) => j.on('mine.id', '=', r.fileId!)).select(['receipt.supplier', 'receipt.receipt_date']).whereRef('file.sha256', '=', 'mine.sha256').where('receipt.organization_id', '=', organizationId).where('receipt.status', '<>', 'void').$if(!!r.id, (q) => q.where('receipt.id', '<>', r.id!)).executeTakeFirst();
      if (dup) out.push(`Dieselbe Datei gehört schon zu einem Beleg von ${dup.supplier} (${formatDate(dup.receipt_date)}).`);
    }
    return out;
  }

  app.post('/receipts/files', { schema: { tags, summary: 'Belegdatei hochladen (PDF, Bild, ZUGFeRD/XRechnung unverändert); Aufbewahrung 8 Jahre', querystring: z.object({ name: z.string().trim().min(1).max(200) }), response: { 201: z.object({ id: z.uuid(), sha256: z.string(), duplicateOf: z.string().nullable() }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Problem(400, 'empty', 'Die Datei ist leer.');
    const sha = await putBlob(bytes);
    const today = await orgToday(db, actor.organizationId);
    const f = await db.insertInto('file').values({ organization_id: actor.organizationId, folder_id: null, member_id: null, sha256: sha, size_bytes: bytes.length, mime_type: String(req.headers['x-file-type'] ?? 'application/octet-stream').slice(0, 100).replace(/[^\w.+/-]/g, '') || 'application/octet-stream', name: req.query.name, retention_class: 'voucher', retain_until: addYears(`${today.slice(0, 4)}-12-31`, 8), uploaded_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
    const dup = await db.selectFrom('receipt').innerJoin('file', 'file.id', 'receipt.file_id').select(['receipt.supplier', 'receipt.receipt_date']).where('receipt.organization_id', '=', actor.organizationId).where('file.sha256', '=', sha).where('receipt.status', '<>', 'void').executeTakeFirst();
    reply.status(201);
    return { id: f.id, sha256: sha, duplicateOf: dup ? `${dup.supplier}, ${formatDate(dup.receipt_date)}` : null };
  });

  app.get('/receipts', { schema: { tags, summary: 'Eingangsbelege', querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), status: z.enum(['open', 'paid', 'void']).optional() }), response: { 200: z.array(receipt) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    return dto(actor.organizationId, undefined, req.query);
  });

  app.post('/receipts', { schema: { tags, summary: 'Eingangsbeleg erfassen (offen; mit `pay` gleich bezahlt und gebucht); warnt bei gleicher Nummer oder Datei', body: receiptInput, response: { 201: z.object({ receipt, warnings: z.array(z.string()) }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const result = await db.transaction().execute(async (tx) => {
      if (b.fileId && !(await tx.selectFrom('file').select('id').where('id', '=', b.fileId).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw notFound('Datei');
      const warnings = await warningsFor(tx, actor.organizationId, b);
      const total = b.lines.reduce((s, l) => s + l.grossCents, 0);
      const r = await tx.insertInto('receipt').values({ organization_id: actor.organizationId, supplier: b.supplier, number: b.number ?? null, receipt_date: b.receiptDate, due_date: b.dueDate ?? null, total_cents: total, file_id: b.fileId ?? null, note: b.note ?? null, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('receipt_line').values(b.lines.map((l, i) => ({ receipt_id: r.id, position: i + 1, text: l.text ?? null, gross_cents: l.grossCents, account_id: l.accountId, tax_rate_id: l.taxRateId ?? null, sphere: l.sphere ?? null, cost_center_id: l.costCenterId ?? null }))).execute();
      await audit(tx, actor.organizationId, actor, { action: 'receipt.recorded', entityType: 'receipt', entityId: r.id, diff: { supplier: [null, b.supplier], totalCents: [null, total] } });
      if (b.pay) await pay(tx, actor, r.id, b.pay);
      return { id: r.id, warnings };
    });
    reply.status(201);
    return { receipt: (await dto(actor.organizationId, [result.id]))[0]!, warnings: result.warnings };
  });

  app.post('/receipts/self-issued', { schema: { tags, summary: 'Eigenbeleg für eine Ausgabe ohne fremden Beleg (PDF wird erzeugt und aufbewahrt)', body: selfIssuedInput, response: { 201: receipt } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const org = await db.selectFrom('organization').select(['name', 'city']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const bytes = await pdf((doc) => {
      doc.font('bold').fontSize(15).text('Eigenbeleg').moveDown(0.2);
      doc.font('text').fontSize(9).fillColor('#5f6874').text(`${org.name} · erstellt am ${formatDate(b.date)}`).fillColor('#14202e').moveDown(1);
      for (const [k, v] of [['Datum der Ausgabe', formatDate(b.date)], ['Wofür', b.text], ['Betrag', money(b.amountCents)], ['Warum kein Beleg', b.reason]] as const) {
        doc.font('text').fontSize(9).fillColor('#5f6874').text(k).font('text').fontSize(11).fillColor('#14202e').text(v).moveDown(0.6);
      }
      doc.moveDown(2).fontSize(10).text(`${org.city ?? ''}, ${formatDate(b.date)}    ${b.signer}`);
      doc.moveTo(doc.page.margins.left, doc.y + 2).lineTo(doc.page.margins.left + 300, doc.y + 2).lineWidth(0.5).stroke();
      doc.fontSize(8).fillColor('#5f6874').text('(Unterschrift)', doc.page.margins.left, doc.y + 5);
    }, 'Eigenbeleg');
    const sha = await putBlob(bytes);
    const today = await orgToday(db, actor.organizationId);
    const id = await db.transaction().execute(async (tx) => {
      const f = await tx.insertInto('file').values({ organization_id: actor.organizationId, folder_id: null, member_id: null, sha256: sha, size_bytes: bytes.length, mime_type: 'application/pdf', name: `Eigenbeleg-${b.date}.pdf`, retention_class: 'voucher', retain_until: addYears(`${today.slice(0, 4)}-12-31`, 8), uploaded_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      const r = await tx.insertInto('receipt').values({ organization_id: actor.organizationId, supplier: 'Eigenbeleg', receipt_date: b.date, total_cents: b.amountCents, file_id: f.id, self_issued: true, self_reason: b.reason, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('receipt_line').values({ receipt_id: r.id, position: 1, text: b.text, gross_cents: b.amountCents, account_id: b.accountId }).execute();
      await audit(tx, actor.organizationId, actor, { action: 'receipt.self_issued', entityType: 'receipt', entityId: r.id, diff: { totalCents: [null, b.amountCents] } });
      if (b.pay) await pay(tx, actor, r.id, b.pay);
      return r.id;
    });
    reply.status(201);
    return (await dto(actor.organizationId, [id]))[0]!;
  });

  app.post('/receipts/:id/pay', { schema: { tags, summary: 'Beleg als bezahlt buchen (Ausgabe am Zahltag, Zufluss-/Abflussprinzip)', params: idParam, body: z.object({ date: z.iso.date(), moneyAccountId: z.uuid() }), response: { 200: receipt } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    await db.transaction().execute((tx) => pay(tx, actor, req.params.id, req.body));
    return (await dto(actor.organizationId, [req.params.id]))[0]!;
  });

  app.post('/receipts/:id/void', { schema: { tags, summary: 'Beleg ungültig machen; eine Zahlung dazu wird storniert (Gegenbuchung heute)', params: idParam, body: z.object({ reason: z.string().trim().min(5).max(300) }), response: { 200: receipt } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    await db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('receipt').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Beleg');
      if (r.status === 'void') throw new Problem(409, 'void', 'Der Beleg ist schon ungültig.');
      if (r.journal_entry_id) {
        await lockJournal(tx, actor.organizationId);
        await reverseEntry(tx, actor.organizationId, r.journal_entry_id, await orgToday(tx, actor.organizationId), actor.userId);
      }
      await tx.updateTable('receipt').set({ status: 'void', void_reason: req.body.reason, updated_at: new Date() }).where('id', '=', r.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'receipt.voided', entityType: 'receipt', entityId: r.id, diff: { reason: [null, req.body.reason] } });
    });
    return (await dto(actor.organizationId, [req.params.id]))[0]!;
  });

  app.get('/receipts/:id/file', { schema: { tags, summary: 'Belegdatei (unverändert, wie hochgeladen)', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    const f = await db.selectFrom('receipt').innerJoin('file', 'file.id', 'receipt.file_id').select(['file.sha256', 'file.mime_type', 'file.name']).where('receipt.id', '=', req.params.id).where('receipt.organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!f) throw notFound('Belegdatei');
    const bytes = await getBlob(f.sha256);
    if (sha256Of(bytes) !== f.sha256) throw new Problem(500, 'integrity', 'Die gespeicherte Datei ist beschädigt.');
    // Inline only for types the browser renders safely; everything else downloads.
    const inline = /^(application\/pdf|image\/(png|jpeg|webp))$/.test(f.mime_type);
    return reply.header('content-type', inline ? f.mime_type : 'application/octet-stream').header('x-content-type-options', 'nosniff').header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`).send(bytes);
  });

  // ---------- Cash book ----------

  async function cashBookOf(actor: Actor, accountId: string, from: string, to: string) {
    const acc = await db.selectFrom('ledger_account').select(['id', 'number', 'name', 'kind']).where('id', '=', accountId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!acc || acc.kind !== 'money') throw notFound('Geldkonto');
    const opening = await sql<{ b: number }>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint as b from journal_line l join journal_entry e on e.id = l.entry_id where l.account_id = ${accountId} and e.entry_date < ${from}::date`.execute(db);
    const rows = await sql<{ number: number; entry_date: string; text: string; d: number; c: number; source: string; source_id: string | null }>`
      select e.number, e.entry_date::text, e.text, sum(l.debit_cents)::bigint as d, sum(l.credit_cents)::bigint as c, e.source, e.source_id
      from journal_line l join journal_entry e on e.id = l.entry_id
      where l.account_id = ${accountId} and e.entry_date between ${from}::date and ${to}::date
      group by e.id order by e.entry_date, e.number`.execute(db);
    let balance = Number(opening.rows[0]?.b ?? 0);
    const openingCents = balance;
    const out = rows.rows.map((r) => {
      balance += Number(r.d) - Number(r.c);
      return { entryNumber: r.number, date: r.entry_date, text: r.text, inCents: Number(r.d), outCents: Number(r.c), balanceCents: balance, receiptId: r.source === 'receipt' ? r.source_id : null };
    });
    return { account: { id: acc.id, number: acc.number, name: acc.name }, from, to, openingCents, rows: out, closingCents: balance };
  }

  const range = z.object({ accountId: z.uuid(), from: z.iso.date(), to: z.iso.date() });
  app.get('/ledger/cash-book', { schema: { tags, summary: 'Kassenbuch eines Geldkontos: chronologisch, nummeriert, mit laufendem Bestand', querystring: range, response: { 200: cashBook } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    return cashBookOf(actor, req.query.accountId, req.query.from, req.query.to);
  });

  app.get('/ledger/cash-book.pdf', { schema: { tags, summary: 'Kassenbuch als PDF', querystring: range } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    const book = await cashBookOf(actor, req.query.accountId, req.query.from, req.query.to);
    const org = await db.selectFrom('organization').select('name').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const bytes = await pdf((doc) => {
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      doc.font('bold').fontSize(14).text(`Kassenbuch ${book.account.number} ${book.account.name}`);
      doc.font('text').fontSize(9).fillColor('#5f6874').text(`${org.name} · ${formatDate(book.from)} bis ${formatDate(book.to)}`).fillColor('#14202e').moveDown(0.8);
      const cols = [left, left + 40, left + 100, right - 210, right - 140, right - 70];
      const head = (y: number) => {
        doc.font('bold').fontSize(8.5).fillColor('#5f6874');
        doc.text('Nr.', cols[0]!, y).text('Datum', cols[1]!, y).text('Text', cols[2]!, y).text('Einnahme', cols[3]!, y, { width: 65, align: 'right' }).text('Ausgabe', cols[4]!, y, { width: 65, align: 'right' }).text('Bestand', cols[5]!, y, { width: 70, align: 'right' });
        doc.fillColor('#14202e');
        return y + 16;
      };
      let y = head(doc.y);
      doc.font('text').fontSize(9).text('Anfangsbestand', cols[2]!, y).text(money(book.openingCents), cols[5]!, y, { width: 70, align: 'right' });
      y += 15;
      for (const r of book.rows) {
        if (y > doc.page.height - 80) {
          doc.addPage();
          y = head(doc.page.margins.top);
        }
        doc.font('text').fontSize(9).text(String(r.entryNumber), cols[0]!, y).text(formatDate(r.date), cols[1]!, y).text(r.text, cols[2]!, y, { width: cols[3]! - cols[2]! - 8, lineBreak: false, ellipsis: true });
        if (r.inCents) doc.text(money(r.inCents), cols[3]!, y, { width: 65, align: 'right' });
        if (r.outCents) doc.text(money(r.outCents), cols[4]!, y, { width: 65, align: 'right' });
        doc.text(money(r.balanceCents), cols[5]!, y, { width: 70, align: 'right' });
        y += 15;
      }
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke();
      doc.font('bold').fontSize(9.5).text('Endbestand', cols[2]!, y + 5).text(money(book.closingCents), cols[5]!, y + 5, { width: 70, align: 'right' });
    }, `Kassenbuch ${book.account.number}`);
    await audit(db, actor.organizationId, actor, { action: 'ledger.cash_book_exported', entityType: 'ledger_account', entityId: book.account.id, diff: { from: [null, book.from], to: [null, book.to] } });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="Kassenbuch-${book.account.number}-${book.from}-${book.to}.pdf"`).send(bytes);
  });
};
