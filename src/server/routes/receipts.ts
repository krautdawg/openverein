import { createRequire } from 'node:module';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import { z } from 'zod';
import { formatDate } from '../../shared/dates.ts';
import { MAX_FILE_BYTES } from '../../shared/documents.ts';
import { expenseClaim } from '../../shared/expenses.ts';
import { bookingLine } from '../../shared/ledger.ts';
import { displayName } from '../../shared/members.ts';
import { cashBook, receipt, receiptInput, selfIssuedInput } from '../../shared/receipts.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { getBlob, putBlob, sha256Of } from '../files/store.ts';
import { notFound, Problem } from '../http/problem.ts';
import { assertCashNotNegative, bookingLines, lockJournal, postEntry, reverseEntry } from '../ledger/service.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide, restrictedFields, type Actor } from '../policy.ts';
import { readEinvoice } from '../receipts/einvoice.ts';
import { sendSystemMail } from '../mail/system.ts';
import { decrypt } from '../crypto.ts';

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
    const b = await bookingLines(tx, actor.organizationId, { kind: 'expense', date: p.date, rateDate: r.receipt_date, moneyAccountId: p.moneyAccountId, lines: lines.map((l) => ({ grossCents: Number(l.gross_cents), accountId: l.account_id, taxRateId: l.tax_rate_id, sphere: l.sphere, costCenterId: l.cost_center_id, text: l.text })) });
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

  /** A receipt file must be an upload for receipts, current, and not on another valid receipt; it becomes a voucher. */
  async function claimFile(tx: Db, organizationId: string, fileId: string | null, receiptId: string | null) {
    if (!fileId) return;
    const f = await tx.selectFrom('file').select(['id', 'created_at']).where('id', '=', fileId).where('organization_id', '=', organizationId).where('purpose', '=', 'receipt').where('superseded_at', 'is', null).forUpdate().executeTakeFirst();
    if (!f) throw notFound('Belegdatei');
    const other = await tx.selectFrom('receipt').select('supplier').where('file_id', '=', fileId).where('status', '<>', 'void').$if(!!receiptId, (q) => q.where('id', '<>', receiptId!)).executeTakeFirst();
    if (other) throw new Problem(409, 'file-in-use', `Diese Datei gehört schon zum Beleg von ${other.supplier}.`);
    const today = await orgToday(tx, organizationId);
    await tx.updateTable('file').set({ retention_class: 'voucher', retain_until: addYears(`${today.slice(0, 4)}-12-31`, 8) }).where('id', '=', fileId).execute();
  }

  app.post('/receipts/files', { schema: { tags, summary: 'Belegdatei hochladen (PDF, Bild, ZUGFeRD/XRechnung unverändert); Aufbewahrung 8 Jahre', querystring: z.object({ name: z.string().trim().min(1).max(200) }), response: { 201: z.object({ id: z.uuid(), sha256: z.string(), duplicateOf: z.string().nullable(), einvoice: z.object({ format: z.enum(['cii', 'ubl']), supplier: z.string().nullable(), number: z.string().nullable(), receiptDate: z.string().nullable(), dueDate: z.string().nullable(), totalCents: z.number().nullable(), groups: z.array(z.object({ ratePct: z.number(), grossCents: z.number() })) }).nullable() }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Problem(400, 'empty', 'Die Datei ist leer.');
    const sha = await putBlob(bytes);
    // Temporary until a receipt uses it: abandoned uploads expire like other temporary files.
    const f = await db.insertInto('file').values({ organization_id: actor.organizationId, folder_id: null, member_id: null, purpose: 'receipt', sha256: sha, size_bytes: bytes.length, mime_type: String(req.headers['x-file-type'] ?? 'application/octet-stream').slice(0, 100).replace(/[^\w.+/-]/g, '') || 'application/octet-stream', name: req.query.name, retention_class: 'temporary', retain_until: null, uploaded_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
    const dup = await db.selectFrom('receipt').innerJoin('file', 'file.id', 'receipt.file_id').select(['receipt.supplier', 'receipt.receipt_date']).where('receipt.organization_id', '=', actor.organizationId).where('file.sha256', '=', sha).where('receipt.status', '<>', 'void').executeTakeFirst();
    reply.status(201);
    // E-invoices (XRechnung, ZUGFeRD) are stored unchanged; what they say is offered to prefill the form.
    return { id: f.id, sha256: sha, duplicateOf: dup ? `${dup.supplier}, ${formatDate(dup.receipt_date)}` : null, einvoice: await readEinvoice(bytes) };
  });

  app.get('/receipts', { schema: { tags, summary: 'Eingangsbelege', querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), status: z.enum(['open', 'paid', 'void']).optional() }), response: { 200: z.array(receipt) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    return dto(actor.organizationId, undefined, req.query);
  });

  /** Records an open receipt (and pays it at once with `pay`) in the caller's transaction. */
  async function recordReceipt(tx: Db, actor: Actor, b: z.infer<typeof receiptInput>) {
    await claimFile(tx, actor.organizationId, b.fileId ?? null, null);
    await bookingLines(tx, actor.organizationId, { kind: 'expense', date: b.receiptDate, moneyAccountId: null, lines: b.lines });
    const warnings = await warningsFor(tx, actor.organizationId, b);
    const total = b.lines.reduce((s, l) => s + l.grossCents, 0);
    const r = await tx.insertInto('receipt').values({ organization_id: actor.organizationId, supplier: b.supplier, number: b.number ?? null, receipt_date: b.receiptDate, due_date: b.dueDate ?? null, total_cents: total, file_id: b.fileId ?? null, note: b.note ?? null, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('receipt_line').values(b.lines.map((l, i) => ({ receipt_id: r.id, position: i + 1, text: l.text ?? null, gross_cents: l.grossCents, account_id: l.accountId, tax_rate_id: l.taxRateId ?? null, sphere: l.sphere ?? null, cost_center_id: l.costCenterId ?? null }))).execute();
    await audit(tx, actor.organizationId, actor, { action: 'receipt.recorded', entityType: 'receipt', entityId: r.id, diff: { supplier: [null, b.supplier], totalCents: [null, total] } });
    if (b.pay) await pay(tx, actor, r.id, b.pay);
    return { id: r.id, warnings };
  }

  // ---------- Expense claims (Auslagen) from the portal ----------
  const claimRows = (organizationId: string) =>
    db.selectFrom('expense_claim').innerJoin('person', 'person.id', 'expense_claim.person_id')
      .select(['expense_claim.id', 'expense_claim.member_id', 'expense_claim.purpose', 'expense_claim.spent_on', 'expense_claim.amount_cents', 'expense_claim.account_holder', 'expense_claim.iban_encrypted', 'expense_claim.status', 'expense_claim.receipt_id', 'expense_claim.reject_reason', 'expense_claim.created_at', 'expense_claim.file_id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('expense_claim.organization_id', '=', organizationId);
  type ClaimRow = Awaited<ReturnType<ReturnType<typeof claimRows>['execute']>>[number];
  const claimDto = (actor: Actor, c: ClaimRow) => {
    const iban = decrypt(c.iban_encrypted);
    return {
      id: c.id, memberId: c.member_id, name: displayName({ kind: c.kind, firstName: c.first_name, lastName: c.last_name, companyName: c.company_name }),
      purpose: c.purpose, spentOn: c.spent_on, amountCents: Number(c.amount_cents), accountHolder: c.account_holder,
      iban: restrictedFields(actor).has('iban') ? `•••• ${iban.slice(-4)}` : iban,
      status: c.status, receiptId: c.receipt_id, rejectReason: c.reject_reason, createdAt: c.created_at.toISOString(),
    };
  };

  /** Tells the member about the decision (best effort: a mail problem never undoes the decision). */
  async function notifyClaim(organizationId: string, id: string, approved: boolean, reason?: string) {
    const c = await db.selectFrom('expense_claim').innerJoin('person', 'person.id', 'expense_claim.person_id').select(['person.email', 'person.first_name', 'person.company_name', 'expense_claim.purpose', 'expense_claim.amount_cents']).where('expense_claim.id', '=', id).executeTakeFirst();
    if (!c?.email) return;
    const betrag = (Number(c.amount_cents) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const entscheidung = approved ? `„${c.purpose}“ ist angenommen. Wir überweisen Dir den Betrag.` : `„${c.purpose}“ ist abgelehnt.${reason ? ` Begründung: ${reason}` : ''}`;
    await sendSystemMail(db, organizationId, 'expense_decided', c.email, { vorname: c.first_name ?? c.company_name ?? '', betrag, entscheidung });
  }

  app.get('/expense-claims', { schema: { tags, summary: 'Eingereichte Auslagen von Mitgliedern (offene zuerst)', response: { 200: z.array(expenseClaim) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    const rows = await claimRows(actor.organizationId).orderBy(sql`expense_claim.status = 'submitted'`, 'desc').orderBy('expense_claim.created_at', 'desc').limit(200).execute();
    return rows.map((c) => claimDto(actor, c));
  });

  app.get('/expense-claims/:id/file', { schema: { tags, summary: 'Beleg einer Auslage ansehen', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    const f = await db.selectFrom('expense_claim').innerJoin('file', 'file.id', 'expense_claim.file_id').select(['file.sha256', 'file.mime_type', 'file.name']).where('expense_claim.id', '=', req.params.id).where('expense_claim.organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!f) throw notFound('Auslage');
    // Uploaded by members: shown as a download, never rendered inline as HTML.
    const safe = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(f.mime_type) ? f.mime_type : 'application/octet-stream';
    return reply.header('content-type', safe).header('content-disposition', `${safe === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').send(await getBlob(f.sha256));
  });

  app.post('/expense-claims/:id/approve', { schema: { tags, summary: 'Auslage annehmen: wird ein offener Beleg (Erstattung danach wie jeder Beleg bezahlen)', params: idParam, body: z.object({ accountId: z.uuid(), sphere: bookingLine.shape.sphere, taxRateId: z.uuid().nullish(), costCenterId: z.uuid().nullish() }), response: { 200: expenseClaim } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    await db.transaction().execute(async (tx) => {
      const c = await tx.selectFrom('expense_claim').innerJoin('person', 'person.id', 'expense_claim.person_id').select(['expense_claim.id', 'expense_claim.status', 'expense_claim.purpose', 'expense_claim.spent_on', 'expense_claim.amount_cents', 'expense_claim.account_holder', 'expense_claim.file_id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name']).where('expense_claim.id', '=', req.params.id).where('expense_claim.organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!c) throw notFound('Auslage');
      if (c.status !== 'submitted') throw new Problem(409, 'decided', 'Über diese Auslage ist schon entschieden.');
      const name = displayName({ kind: c.kind, firstName: c.first_name, lastName: c.last_name, companyName: c.company_name });
      const { id } = await recordReceipt(tx, actor, {
        supplier: `Auslage ${name}`, number: null, receiptDate: c.spent_on, dueDate: null, fileId: c.file_id,
        note: `Erstattung an ${c.account_holder} (IBAN in der Auslage)`,
        lines: [{ text: c.purpose, grossCents: Number(c.amount_cents), accountId: req.body.accountId, sphere: req.body.sphere, taxRateId: req.body.taxRateId ?? null, costCenterId: req.body.costCenterId ?? null }],
        pay: null,
      });
      await tx.updateTable('expense_claim').set({ status: 'approved', receipt_id: id, decided_by: actor.userId, decided_at: new Date() }).where('id', '=', c.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'expense_claim.approved', entityType: 'expense_claim', entityId: c.id, diff: { receiptId: [null, id] } });
    });
    await notifyClaim(actor.organizationId, req.params.id, true);
    return claimDto(actor, (await claimRows(actor.organizationId).where('expense_claim.id', '=', req.params.id).executeTakeFirstOrThrow()));
  });

  app.post('/expense-claims/:id/reject', { schema: { tags, summary: 'Auslage ablehnen (mit Begründung für das Mitglied)', params: idParam, body: z.object({ reason: z.string().trim().min(1, 'Bitte begründen.').max(500) }), response: { 200: expenseClaim } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    await db.transaction().execute(async (tx) => {
      const res = await tx.updateTable('expense_claim').set({ status: 'rejected', reject_reason: req.body.reason, decided_by: actor.userId, decided_at: new Date() }).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).where('status', '=', 'submitted').executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw new Problem(409, 'decided', 'Diese Auslage gibt es nicht oder es ist schon entschieden.');
      await audit(tx, actor.organizationId, actor, { action: 'expense_claim.rejected', entityType: 'expense_claim', entityId: req.params.id, diff: { reason: [null, req.body.reason] } });
    });
    await notifyClaim(actor.organizationId, req.params.id, false, req.body.reason);
    return claimDto(actor, (await claimRows(actor.organizationId).where('expense_claim.id', '=', req.params.id).executeTakeFirstOrThrow()));
  });

  app.post('/receipts', { schema: { tags, summary: 'Eingangsbeleg erfassen (offen; mit `pay` gleich bezahlt und gebucht); warnt bei gleicher Nummer oder Datei', body: receiptInput, response: { 201: z.object({ receipt, warnings: z.array(z.string()) }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const result = await db.transaction().execute((tx) => recordReceipt(tx, actor, req.body));
    reply.status(201);
    return { receipt: (await dto(actor.organizationId, [result.id]))[0]!, warnings: result.warnings };
  });

  app.put('/receipts/:id', { schema: { tags, summary: 'Offenen Beleg ändern (bezahlte Belege sind gebucht und fest)', params: idParam, body: receiptInput.omit({ pay: true }), response: { 200: z.object({ receipt, warnings: z.array(z.string()) }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const warnings = await db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('receipt').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Beleg');
      if (r.status !== 'open') throw new Problem(409, 'not-open', 'Nur offene Belege lassen sich ändern.', 'Mach den Beleg ungültig und erfasse ihn neu.');
      if ((b.fileId ?? null) !== r.file_id) await claimFile(tx, actor.organizationId, b.fileId ?? null, r.id);
      await bookingLines(tx, actor.organizationId, { kind: 'expense', date: b.receiptDate, moneyAccountId: null, lines: b.lines });
      const warnings = await warningsFor(tx, actor.organizationId, { ...b, id: r.id });
      const total = b.lines.reduce((s, l) => s + l.grossCents, 0);
      await tx.updateTable('receipt').set({ supplier: b.supplier, number: b.number ?? null, receipt_date: b.receiptDate, due_date: b.dueDate ?? null, total_cents: total, file_id: b.fileId ?? null, note: b.note ?? null, updated_at: new Date() }).where('id', '=', r.id).execute();
      await tx.deleteFrom('receipt_line').where('receipt_id', '=', r.id).execute();
      await tx.insertInto('receipt_line').values(b.lines.map((l, i) => ({ receipt_id: r.id, position: i + 1, text: l.text ?? null, gross_cents: l.grossCents, account_id: l.accountId, tax_rate_id: l.taxRateId ?? null, sphere: l.sphere ?? null, cost_center_id: l.costCenterId ?? null }))).execute();
      await audit(tx, actor.organizationId, actor, { action: 'receipt.updated', entityType: 'receipt', entityId: r.id, diff: { totalCents: [Number(r.total_cents), total], supplier: [r.supplier, b.supplier] } });
      return warnings;
    });
    return { receipt: (await dto(actor.organizationId, [req.params.id]))[0]!, warnings };
  });

  app.post('/receipts/self-issued', { schema: { tags, summary: 'Eigenbeleg für eine Ausgabe ohne fremden Beleg (PDF wird erzeugt und aufbewahrt)', body: selfIssuedInput, response: { 201: receipt } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    const org = await db.selectFrom('organization').select(['name', 'city']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const created = await orgToday(db, actor.organizationId);
    if (b.date > created) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'date', message: 'Das Datum liegt in der Zukunft.' }] });
    // GoBD: the voucher states when it was actually made, not only when the expense happened.
    const bytes = await pdf((doc) => {
      doc.font('bold').fontSize(15).text('Eigenbeleg').moveDown(0.2);
      doc.font('text').fontSize(9).fillColor('#5f6874').text(`${org.name} · erstellt am ${formatDate(created)}`).fillColor('#14202e').moveDown(1);
      for (const [k, v] of [['Datum der Ausgabe', formatDate(b.date)], ['Empfänger:in', b.payee], ['Wofür', b.text], ['Betrag', money(b.amountCents)], ['Warum kein Beleg', b.reason]] as const) {
        doc.font('text').fontSize(9).fillColor('#5f6874').text(k).font('text').fontSize(11).fillColor('#14202e').text(v).moveDown(0.6);
      }
      doc.moveDown(2).fontSize(10).text(`${org.city ?? ''}, ${formatDate(created)}    ${b.signer}`);
      doc.moveTo(doc.page.margins.left, doc.y + 2).lineTo(doc.page.margins.left + 300, doc.y + 2).lineWidth(0.5).stroke();
      doc.fontSize(8).fillColor('#5f6874').text('(Unterschrift)', doc.page.margins.left, doc.y + 5);
    }, 'Eigenbeleg');
    const sha = await putBlob(bytes);
    const today = await orgToday(db, actor.organizationId);
    const id = await db.transaction().execute(async (tx) => {
      const f = await tx.insertInto('file').values({ organization_id: actor.organizationId, folder_id: null, member_id: null, purpose: 'receipt', sha256: sha, size_bytes: bytes.length, mime_type: 'application/pdf', name: `Eigenbeleg-${b.date}.pdf`, retention_class: 'voucher', retain_until: addYears(`${today.slice(0, 4)}-12-31`, 8), uploaded_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
      await bookingLines(tx, actor.organizationId, { kind: 'expense', date: b.date, moneyAccountId: null, lines: [{ grossCents: b.amountCents, accountId: b.accountId }] });
      const r = await tx.insertInto('receipt').values({ organization_id: actor.organizationId, supplier: b.payee, receipt_date: b.date, total_cents: b.amountCents, file_id: f.id, self_issued: true, self_reason: b.reason, created_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
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
    return reply
      .header('content-type', inline ? f.mime_type : 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('content-security-policy', f.mime_type === 'application/pdf' ? "default-src 'none'" : "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store')
      .send(bytes);
  });

  // ---------- Cash book ----------

  async function cashBookOf(actor: Actor, accountId: string, from: string, to: string) {
    const acc = await db.selectFrom('ledger_account').select(['id', 'number', 'name', 'kind']).where('id', '=', accountId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!acc || acc.kind !== 'money') throw notFound('Geldkonto');
    const opening = await sql<{ b: number }>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint as b from journal_line l join journal_entry e on e.id = l.entry_id where l.account_id = ${accountId} and e.entry_date < ${from}::date`.execute(db);
    const rows = await sql<{ number: number; entry_date: string; text: string; d: number; c: number; source: string; source_id: string | null; has_file: boolean }>`
      select e.number, e.entry_date::text, e.text, sum(l.debit_cents)::bigint as d, sum(l.credit_cents)::bigint as c, e.source, e.source_id,
        exists (select 1 from receipt r where e.source = 'receipt' and r.id = e.source_id and r.file_id is not null) as has_file
      from journal_line l join journal_entry e on e.id = l.entry_id
      where l.account_id = ${accountId} and e.entry_date between ${from}::date and ${to}::date
      group by e.id order by e.entry_date, e.number`.execute(db);
    let balance = Number(opening.rows[0]?.b ?? 0);
    const openingCents = balance;
    const out = rows.rows.map((r) => {
      balance += Number(r.d) - Number(r.c);
      return { entryNumber: r.number, date: r.entry_date, text: r.text, inCents: Number(r.d), outCents: Number(r.c), balanceCents: balance, receiptId: r.source === 'receipt' ? r.source_id : null, receiptHasFile: r.has_file };
    });
    return { account: { id: acc.id, number: acc.number, name: acc.name }, from, to, openingCents, rows: out, closingCents: balance };
  }

  const range = z.object({ accountId: z.uuid(), from: z.iso.date(), to: z.iso.date() }).refine((r) => r.from <= r.to, { message: 'Der Anfang liegt nach dem Ende.' });
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
