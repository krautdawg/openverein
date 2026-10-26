import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { donation, donationInput, donationSettings, receipt } from '../../shared/donations.ts';
import { SYSTEM_TEMPLATES } from '../../shared/mail.ts';
import { mergeLetters } from '../letters.ts';
import { emailHash } from '../mail/worker.ts';
import { createMessage } from './messages.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { descriptionFits, RECEIPT_TEMPLATE, RECEIPT_TEMPLATE_IN_KIND, renderReceiptPdf } from '../donations/receipt-pdf.ts';
import { notFound, Problem } from '../http/problem.ts';
import { lockJournal, postEntry, reverseEntry } from '../ledger/service.ts';
import { nextNumber } from '../members/numbers.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide, type Actor } from '../policy.ts';

const tags = ['donations'];
const idParam = z.object({ id: z.uuid() });
const invalid = (field: string, message: string) => new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field, message }] });
const nameOf = (p: { kind: string; first_name: string | null; last_name: string | null; company_name: string | null }) => (p.kind === 'organisation' ? (p.company_name ?? '') : [p.first_name, p.last_name].filter(Boolean).join(' '));
const yearsBefore = (d: string, n: number) => `${Number(d.slice(0, 4)) - n}${d.slice(4)}`;

export const donationRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/donations/settings', { schema: { tags, summary: 'Angaben zur Steuerbegünstigung für Zuwendungsbestätigungen', response: { 200: donationSettings } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'read');
    const o = await db.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    return { kind: o.exemption_kind, office: o.exemption_office, taxNumber: o.exemption_tax_number, date: o.exemption_date, period: o.exemption_period, purposes: o.exemption_purposes, signer: o.receipt_signer };
  });

  app.put('/donations/settings', { schema: { tags, summary: 'Angaben zur Steuerbegünstigung speichern', body: donationSettings, response: { 200: donationSettings } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'write');
    const b = req.body;
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('organization').set({ exemption_kind: b.kind, exemption_office: b.office, exemption_tax_number: b.taxNumber, exemption_date: b.date, exemption_period: b.period, exemption_purposes: b.purposes, receipt_signer: b.signer, updated_at: new Date() }).where('id', '=', actor.organizationId).execute();
      await audit(tx, actor.organizationId, actor, { action: 'donations.settings', entityType: 'organization', entityId: actor.organizationId, diff: { kind: [null, b.kind], date: [null, b.date] } });
    });
    return b;
  });

  async function donationsDto(organizationId: string, filter: { year?: number; ids?: string[] }) {
    let q = db
      .selectFrom('donation')
      .innerJoin('person', 'person.id', 'donation.person_id')
      .leftJoin('journal_entry', 'journal_entry.id', 'donation.journal_entry_id')
      .leftJoin('donation_receipt_item as i', (j) => j.onRef('i.donation_id', '=', 'donation.id').on('i.live', '=', true))
      .leftJoin('donation_receipt as r', 'r.id', 'i.receipt_id')
      .select(['donation.id', 'donation.person_id', 'donation.donated_on', 'donation.amount_cents', 'donation.waiver', 'donation.note', 'donation.kind as dkind', 'donation.in_kind_description', 'donation.in_kind_source', 'donation.in_kind_valuation_docs', 'journal_entry.number as journal', 'r.id as receipt_id', 'r.number as receipt_number', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .where('donation.organization_id', '=', organizationId)
      .where('donation.voided_at', 'is', null);
    if (filter.year) q = q.where('donation.donated_on', '>=', `${filter.year}-01-01`).where('donation.donated_on', '<=', `${filter.year}-12-31`);
    if (filter.ids) q = q.where('donation.id', 'in', filter.ids);
    const rows = await q.orderBy('donation.donated_on', 'desc').orderBy('donation.id', 'desc').execute();
    return rows.map((d) => ({ id: d.id, personId: d.person_id, donorName: nameOf(d), date: d.donated_on, amountCents: Number(d.amount_cents), waiver: d.waiver, note: d.note, inKind: d.dkind === 'in_kind' ? { description: d.in_kind_description!, source: d.in_kind_source!, valuationDocs: !!d.in_kind_valuation_docs } : null, journalNumber: d.journal ?? null, receipt: d.receipt_id ? { id: d.receipt_id, number: d.receipt_number! } : null }));
  }

  app.get('/donations', { schema: { tags, summary: 'Spenden eines Jahres mit Bestätigungsstand', querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), response: { 200: z.array(donation) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'read');
    return donationsDto(actor.organizationId, { year: req.query.year });
  });

  app.post('/donations', { schema: { tags, summary: 'Spende erfassen: Geld (auf Wunsch gleich ins Journal buchen) oder Sache (mit Wert, Beschreibung und Herkunft)', body: donationInput, response: { 201: donation } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'write');
    const b = req.body;
    const today = await orgToday(db, actor.organizationId);
    if (b.date > today) throw invalid('date', 'Das Datum liegt in der Zukunft.');
    // The receipt prints the description completely or not at all.
    if (b.inKind && !descriptionFits(b.inKind.description)) throw invalid('inKind', 'Die Beschreibung ist zu lang für das Feld der Bestätigung (etwa drei Zeilen). Bitte kürzen.');
    if (b.moneyAccountId && b.waiver) throw invalid('moneyAccountId', 'Bei einem Verzicht auf Aufwendungsersatz fließt kein Geld; bitte ohne Geldkonto erfassen.');
    const id = await db.transaction().execute(async (tx) => {
      let personId = b.personId;
      if (personId) {
        if (!(await tx.selectFrom('person').select('id').where('id', '=', personId).where('organization_id', '=', actor.organizationId).executeTakeFirst())) throw invalid('personId', 'Person nicht gefunden.');
      } else {
        const d = b.donor!;
        if (d.kind === 'organisation' ? !d.companyName : !d.lastName) throw invalid('donor', 'Bitte einen Namen angeben.');
        personId = (await tx.insertInto('person').values({ organization_id: actor.organizationId, kind: d.kind, first_name: d.firstName ?? null, last_name: d.lastName ?? null, company_name: d.companyName ?? null, street: d.street, postal_code: d.postalCode, city: d.city, email: d.email ?? null }).returning('id').executeTakeFirstOrThrow()).id;
        await audit(tx, actor.organizationId, actor, { action: 'person.created', entityType: 'person', entityId: personId, diff: { source: [null, 'donation'] } });
      }
      let entryId: string | null = null;
      if (b.moneyAccountId) {
        const accounts = await tx.selectFrom('ledger_account').select(['id', 'kind', 'default_sphere', 'retired_at']).where('organization_id', '=', actor.organizationId).execute();
        const money = accounts.find((a) => a.id === b.moneyAccountId && a.kind === 'money' && !a.retired_at);
        const income = accounts.find((a) => a.id === b.incomeAccountId && a.kind === 'income' && !a.retired_at);
        if (!money) throw invalid('moneyAccountId', 'Bitte ein Geldkonto wählen.');
        if (!income) throw invalid('incomeAccountId', 'Bitte ein Einnahmenkonto wählen.');
        await lockJournal(tx, actor.organizationId);
        const person = await tx.selectFrom('person').select(['kind', 'first_name', 'last_name', 'company_name']).where('id', '=', personId).executeTakeFirstOrThrow();
        entryId = (await postEntry(tx, actor.organizationId, {
          date: b.date, text: `Spende ${nameOf(person)}`, source: 'donation', createdBy: actor.userId,
          lines: [{ accountId: money.id, debitCents: b.amountCents, sphere: 'ideell' }, { accountId: income.id, creditCents: b.amountCents, sphere: 'ideell' }],
        })).id;
      }
      const d = await tx.insertInto('donation').values({ organization_id: actor.organizationId, person_id: personId, donated_on: b.date, amount_cents: b.amountCents, waiver: b.waiver, note: b.note ?? null, journal_entry_id: entryId, created_by: actor.userId, ...(b.inKind && { kind: 'in_kind' as const, in_kind_description: b.inKind.description, in_kind_source: b.inKind.source, in_kind_valuation_docs: b.inKind.valuationDocs }) }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'donation.created', entityType: 'donation', entityId: d.id, diff: { amountCents: [null, b.amountCents] } });
      return d.id;
    });
    reply.status(201);
    return (await donationsDto(actor.organizationId, { ids: [id] }))[0]!;
  });

  app.post('/donations/:id/void', { schema: { tags, summary: 'Falsch erfasste Spende ungültig machen (ohne gültige Bestätigung); eine Buchung dazu wird storniert', params: idParam, body: z.object({ reason: z.string().trim().min(5).max(300) }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'write');
    await db.transaction().execute(async (tx) => {
      const d = await tx.selectFrom('donation').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!d || d.voided_at) throw notFound('Spende');
      if (await tx.selectFrom('donation_receipt_item').select('donation_id').where('donation_id', '=', d.id).where('live', '=', true).executeTakeFirst()) throw new Problem(409, 'on-receipt', 'Für diese Spende gibt es eine gültige Bestätigung.', 'Storniere zuerst die Bestätigung.');
      if (d.journal_entry_id && !(await tx.selectFrom('journal_entry').select('id').where('reverses_id', '=', d.journal_entry_id).executeTakeFirst())) {
        await lockJournal(tx, actor.organizationId);
        await reverseEntry(tx, actor.organizationId, d.journal_entry_id, await orgToday(tx, actor.organizationId), actor.userId);
      }
      await tx.updateTable('donation').set({ voided_at: new Date(), void_reason: req.body.reason }).where('id', '=', d.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'donation.voided', entityType: 'donation', entityId: d.id, diff: { amountCents: [d.amount_cents, null], reason: [null, req.body.reason] } });
    });
    return reply.status(204).send();
  });

  app.get('/donations/donors', { schema: { tags, summary: 'Spender:innen suchen: frühere Spender:innen und Mitglieder', querystring: z.object({ q: z.string().trim().min(2).max(100) }), response: { 200: z.array(z.object({ personId: z.uuid(), name: z.string(), city: z.string().nullable(), membershipNumber: z.string().nullable() })) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'read');
    const like = `%${req.query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await db
      .selectFrom('person')
      .leftJoin('member', 'member.person_id', 'person.id')
      .select(['person.id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.city', 'member.membership_number'])
      .where('person.organization_id', '=', actor.organizationId)
      .where('person.status', '=', 'active')
      .where((eb) => eb.or([eb.exists(eb.selectFrom('donation').select('donation.id').whereRef('donation.person_id', '=', 'person.id')), eb('member.id', 'is not', null)]))
      .where(sql<boolean>`unaccent(concat_ws(' ', person.first_name, person.last_name, person.company_name, member.membership_number)) ilike unaccent(${like})`)
      .orderBy('person.last_name')
      .limit(8)
      .execute();
    return rows.map((r) => ({ personId: r.id, name: nameOf(r), city: r.city, membershipNumber: r.membership_number }));
  });

  // ---------- Receipts ----------

  async function receiptsDto(organizationId: string, filter: { year?: number; ids?: string[] }) {
    let q = db
      .selectFrom('donation_receipt as r')
      .innerJoin('person', 'person.id', 'r.person_id')
      .select(['r.id', 'r.number', 'r.kind', 'r.person_id', 'r.issued_on', 'r.total_cents', 'r.status', 'r.cancel_reason', 'person.kind as pkind', 'person.first_name', 'person.last_name', 'person.company_name'])
      .select((eb) => eb.selectFrom('donation_receipt_item').select(sql<number>`count(*)::int`.as('n')).whereRef('donation_receipt_item.receipt_id', '=', 'r.id').as('n'))
      .where('r.organization_id', '=', organizationId);
    if (filter.year) q = q.where('r.issued_on', '>=', `${filter.year}-01-01`).where('r.issued_on', '<=', `${filter.year + 1}-12-31`);
    if (filter.ids) q = q.where('r.id', 'in', filter.ids);
    const rows = await q.orderBy('r.created_at', 'desc').execute();
    return rows.map((r) => ({ id: r.id, number: r.number, kind: r.kind, personId: r.person_id, donorName: nameOf({ kind: r.pkind, first_name: r.first_name, last_name: r.last_name, company_name: r.company_name }), issuedOn: r.issued_on, totalCents: Number(r.total_cents), status: r.status, cancelReason: r.cancel_reason, donationCount: r.n ?? 0 }));
  }

  /** Issues one receipt for donations of one person in one calendar year; one donation → single, several → collective. */
  async function issue(tx: Db, actor: Actor, personId: string, donationIds: string[]) {
    const org = await tx.selectFrom('organization').selectAll().where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const today = await orgToday(tx, actor.organizationId);
    if (!org.exemption_kind || !org.exemption_office || !org.exemption_tax_number || !org.exemption_date || !org.exemption_purposes || (org.exemption_kind === 'freistellung' && !org.exemption_period)) throw new Problem(409, 'exemption-missing', 'Die Angaben zur Steuerbegünstigung fehlen.', 'Trag Finanzamt, Steuernummer, Bescheid, Veranlagungszeitraum und Zwecke unter Spenden → Einstellungen ein.');
    if (!org.city) throw new Problem(409, 'address-missing', 'Die Anschrift des Vereins fehlt.', 'Trag sie unter Einstellungen → Verein ein; der Ort steht neben der Unterschrift.');
    // § 63 Abs. 5 AO: no receipts on a notice older than five years (exemption) or three years (§ 60a assessment).
    if (org.exemption_date <= yearsBefore(today, org.exemption_kind === 'freistellung' ? 5 : 3)) throw new Problem(409, 'exemption-expired', 'Der Bescheid ist zu alt für Zuwendungsbestätigungen (§ 63 Abs. 5 AO).', 'Trag den aktuellen Bescheid ein.');
    const person = await tx.selectFrom('person').selectAll().where('id', '=', personId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!person) throw notFound('Person');
    if (!person.street || !person.postal_code || !person.city) throw new Problem(409, 'address-missing', `Für ${nameOf(person)} fehlt die Anschrift.`, 'Eine Zuwendungsbestätigung braucht Name und Anschrift.');
    const items = await tx.selectFrom('donation').selectAll().where('id', 'in', donationIds).where('person_id', '=', personId).where('organization_id', '=', actor.organizationId).where('voided_at', 'is', null).orderBy('id').forUpdate().execute();
    if (items.length !== donationIds.length || !items.length) throw invalid('donationIds', 'Spenden nicht gefunden oder von einer anderen Person.');
    if (new Set(items.map((i) => i.donated_on.slice(0, 4))).size > 1) throw invalid('donationIds', 'Eine Sammelbestätigung gilt für ein Kalenderjahr.');
    // Sachzuwendungen have their own template and are never part of a collective receipt.
    const inKind = items.length === 1 && items[0]!.kind === 'in_kind' ? items[0]! : null;
    // Older records: refuse what the template would print incompletely or the law requires evidence for.
    if (inKind && inKind.in_kind_source === 'private' && !inKind.in_kind_valuation_docs) throw invalid('donationIds', 'Für Sachen aus dem Privatvermögen braucht es Unterlagen zur Wertermittlung. Mach die Spende ungültig und erfasse sie mit Unterlagen neu.');
    if (inKind && !descriptionFits(inKind.in_kind_description!)) throw invalid('donationIds', 'Die Beschreibung passt nicht vollständig in das Feld der Bestätigung. Mach die Spende ungültig und erfasse sie kürzer neu.');
    if (!inKind && items.some((i) => i.kind === 'in_kind')) throw invalid('donationIds', 'Sachspenden bekommen jede eine eigene Bestätigung.');
    const number = await nextNumber(tx, actor.organizationId, 'donation_receipt', 'ZB-{YYYY}-{seq:4}', today);
    const total = items.reduce((s, i) => s + Number(i.amount_cents), 0);
    const pdf = await renderReceiptPdf({
      number,
      issuedOn: today,
      donor: [nameOf(person), person.street, `${person.postal_code} ${person.city}`],
      items: items.map((i) => ({ date: i.donated_on, amountCents: Number(i.amount_cents), waiver: i.waiver })),
      org: { name: org.name, street: org.street, postalCode: org.postal_code, city: org.city },
      exemption: { kind: org.exemption_kind, office: org.exemption_office, taxNumber: org.exemption_tax_number, date: org.exemption_date, period: org.exemption_period, purposes: org.exemption_purposes },
      signer: org.receipt_signer,
      demo: org.is_demo,
      ...(inKind && { inKind: { description: inKind.in_kind_description!, source: inKind.in_kind_source!, valuationDocs: !!inKind.in_kind_valuation_docs } }),
    });
    const r = await tx
      .insertInto('donation_receipt')
      .values({ organization_id: actor.organizationId, number, kind: items.length > 1 ? 'collective' : 'single', person_id: personId, issued_on: today, total_cents: total, template: inKind ? RECEIPT_TEMPLATE_IN_KIND : RECEIPT_TEMPLATE, pdf, sha256: createHash('sha256').update(pdf).digest('hex'), created_by: actor.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    // The partial unique index refuses a donation that is already on a valid receipt.
    await tx.insertInto('donation_receipt_item').values(items.map((i) => ({ receipt_id: r.id, donation_id: i.id }))).execute();
    await audit(tx, actor.organizationId, actor, { action: 'donation_receipt.issued', entityType: 'donation_receipt', entityId: r.id, diff: { number: [null, number], totalCents: [null, total] } });
    return r.id;
  }

  app.get('/donation-receipts', { schema: { tags, summary: 'Ausgestellte Zuwendungsbestätigungen (ausgestellt im Jahr oder im Folgejahr)', querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), response: { 200: z.array(receipt) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'read');
    return receiptsDto(actor.organizationId, { year: req.query.year });
  });

  app.post('/donation-receipts/send', { schema: { tags, summary: 'Zuwendungsbestätigungen per E-Mail mit PDF verschicken; wer Briefe bevorzugt oder keine Adresse hat, wird zum Drucken gelistet', body: z.object({ receiptIds: z.array(z.uuid()).min(1).max(5000), resend: z.boolean().default(false) }), response: { 201: z.object({ sent: z.number(), alreadySent: z.number(), messageIds: z.array(z.uuid()), toPrint: z.array(z.object({ receiptId: z.uuid(), number: z.string(), name: z.string(), reason: z.string() })) }) } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'write');
    requireClubWide(actor, 'communication', 'write');
    const rows = await db.selectFrom('donation_receipt as r').innerJoin('person', 'person.id', 'r.person_id')
      .select(['r.id', 'r.number', 'r.person_id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.email', 'person.preferred_channel'])
      .where('r.organization_id', '=', actor.organizationId).where('r.status', '=', 'issued').where('r.id', 'in', req.body.receiptIds).orderBy('r.number').execute();
    const sentBefore = new Set(req.body.resend || !rows.length ? [] : (await db.selectFrom('delivery').select('donation_receipt_id').where('donation_receipt_id', 'in', rows.map((r) => r.id)).where('status', 'in', ['queued', 'sending', 'sent']).execute()).map((d) => d.donation_receipt_id));
    const suppressed = new Set((await db.selectFrom('suppression').select('email_hash').where('organization_id', '=', actor.organizationId).where('reason', 'in', ['bounce', 'manual']).execute()).map((x) => x.email_hash));
    const send: { personId: string; memberId: string | null; email: string; donationReceiptId: string }[] = [];
    const toPrint: { receiptId: string; number: string; name: string; reason: string }[] = [];
    let alreadySent = 0;
    for (const r of rows) {
      if (sentBefore.has(r.id)) { alreadySent++; continue; }
      const reason = r.preferred_channel === 'letter' ? 'bevorzugt Brief' : !r.email ? 'keine E-Mail-Adresse' : suppressed.has(emailHash(r.email)) ? 'Adresse unzustellbar' : null;
      if (reason) toPrint.push({ receiptId: r.id, number: r.number, name: nameOf(r), reason });
      else send.push({ personId: r.person_id, memberId: null, email: r.email!, donationReceiptId: r.id });
    }
    const own = await db.selectFrom('mail_template').select(['subject', 'body']).where('organization_id', '=', actor.organizationId).where('key', '=', 'donation_receipt').executeTakeFirst();
    const text = own ?? SYSTEM_TEMPLATES.donation_receipt;
    // One delivery per person and message: several receipts for one person go out as separate messages.
    const batches: (typeof send)[] = [];
    for (const x of send) {
      const b = batches.find((bb) => !bb.some((y) => y.personId === x.personId));
      if (b) b.push(x);
      else batches.push([x]);
    }
    const messageIds: string[] = [];
    await db.transaction().execute(async (tx) => {
      for (const b of batches) messageIds.push(await createMessage(tx, actor, { kind: 'donation_receipts', category: 'notice', subject: text.subject, body: text.body, filter: { receiptIds: b.map((x) => x.donationReceiptId) } }, b));
    });
    reply.status(201);
    return { sent: send.length, alreadySent, messageIds, toPrint };
  });

  app.post('/donation-receipts/letters.pdf', { schema: { tags, summary: 'Zuwendungsbestätigungen als ein PDF zum Drucken (nach Postleitzahl, für Duplexdruck)', body: z.object({ receiptIds: z.array(z.uuid()).min(1).max(5000) }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'read');
    const rows = await db.selectFrom('donation_receipt as r').innerJoin('person', 'person.id', 'r.person_id').select(['r.number', 'r.pdf', 'person.postal_code'])
      .where('r.organization_id', '=', actor.organizationId).where('r.status', '=', 'issued').where('r.id', 'in', req.body.receiptIds).execute();
    if (!rows.length) throw notFound('Zuwendungsbestätigung');
    const merged = await mergeLetters(rows.map((r) => ({ pdf: r.pdf, postalCode: r.postal_code ?? '99999z', sortKey: r.number })));
    await audit(db, actor.organizationId, actor, { action: 'donation_receipt.letters_printed', entityType: 'organization', entityId: actor.organizationId, diff: { numbers: [null, rows.map((r) => r.number)] } });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="Zuwendungsbestaetigungen-${new Date().toISOString().slice(0, 10)}.pdf"`).header('cache-control', 'private, no-store').send(merged);
  });

  app.post('/donation-receipts', { schema: { tags, summary: 'Zuwendungsbestätigung ausstellen (eine Spende: Einzel-, mehrere: Sammelbestätigung)', body: z.object({ personId: z.uuid(), donationIds: z.array(z.uuid()).min(1).max(500) }), response: { 201: receipt } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'write');
    const id = await db.transaction().execute((tx) => issue(tx, actor, req.body.personId, [...new Set(req.body.donationIds)]));
    reply.status(201);
    return (await receiptsDto(actor.organizationId, { ids: [id] }))[0]!;
  });

  app.post('/donation-receipts/annual', { schema: { tags, summary: 'Jahresbestätigungen: für jede Person mit unbestätigten Spenden des Jahres eine Bestätigung', body: z.object({ year: z.number().int().min(2000).max(2100) }), response: { 200: z.object({ issued: z.number(), skipped: z.array(z.object({ donorName: z.string(), reason: z.string() })) }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'write');
    const open = (await donationsDto(actor.organizationId, { year: req.body.year })).filter((d) => !d.receipt);
    // Money donations of a person go on one receipt; each in-kind donation gets its own.
    const byPerson = new Map<string, typeof open>();
    for (const d of open) {
      const key = d.inKind ? `${d.personId}:${d.id}` : d.personId;
      byPerson.set(key, [...(byPerson.get(key) ?? []), d]);
    }
    let issued = 0;
    const skipped: { donorName: string; reason: string }[] = [];
    for (const ds of byPerson.values()) {
      try {
        await db.transaction().execute((tx) => issue(tx, actor, ds[0]!.personId, ds.map((d) => d.id)));
        issued++;
      } catch (err) {
        // Club-wide problems stop the run; a single donor's problem is reported and skipped.
        if (err instanceof Problem && err.type.startsWith('exemption')) throw err;
        skipped.push({ donorName: ds[0]!.donorName, reason: err instanceof Problem ? err.message : 'Fehler beim Ausstellen.' });
        if (!(err instanceof Problem)) req.log.error(err);
      }
    }
    return { issued, skipped };
  });

  app.get('/donation-receipts/:id/pdf', { schema: { tags, summary: 'PDF der Zuwendungsbestätigung (immer dieselben Bytes)', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'read');
    const r = await db.selectFrom('donation_receipt').select(['pdf', 'number']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!r) throw notFound('Bestätigung');
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Zuwendungsbestaetigung-${r.number}.pdf"`).send(r.pdf);
  });

  app.post('/donation-receipts/:id/cancel', { schema: { tags, summary: 'Bestätigung stornieren (z. B. falsche Angaben); die Spenden lassen sich danach neu bestätigen', params: idParam, body: z.object({ reason: z.string().trim().min(5).max(300) }), response: { 200: receipt } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'donations', 'write');
    await db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('donation_receipt').select(['id', 'status']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Bestätigung');
      if (r.status === 'cancelled') throw new Problem(409, 'cancelled', 'Diese Bestätigung ist schon storniert.');
      await tx.updateTable('donation_receipt').set({ status: 'cancelled', cancel_reason: req.body.reason, cancelled_at: new Date() }).where('id', '=', r.id).execute();
      await tx.updateTable('donation_receipt_item').set({ live: false }).where('receipt_id', '=', r.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'donation_receipt.cancelled', entityType: 'donation_receipt', entityId: r.id, diff: { reason: [null, req.body.reason] } });
    });
    return (await receiptsDto(actor.organizationId, { ids: [req.params.id] }))[0]!;
  });
};
