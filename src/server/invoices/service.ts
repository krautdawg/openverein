import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { addDays, formatDate } from '../../shared/dates.ts';
import type { PaymentMethod } from '../db.ts';
import type { Db, InvoiceKind } from '../db.ts';
import { Problem } from '../http/problem.ts';
import { fillInvoiceText, grossFromNet } from '../../shared/invoices.ts';
import { nextNumber } from '../members/numbers.ts';
import { assertNotLive } from '../sepa/live.ts';
import { epcPayload, formatIban, renderInvoicePdf } from './pdf.ts';
import { decrypt, encryptBytes } from '../crypto.ts';
import { missingFields, xrechnungCii, type XInvoice } from './xrechnung.ts';

/** Everything the PDF needs, frozen at issue time so the document never changes afterwards. */
export interface IssueSnapshot {
  recipient: { name: string; lines: string[] };
  membershipNumber: string | null;
  org: { name: string; street: string | null; postalCode: string | null; city: string | null; email: string | null; iban: string | null; bic: string | null; bankName: string | null; isDemo: boolean; smallBusiness?: boolean };
  paymentMethod: string | null;
  cancelsNumber: string | null;
  /** SEPA pre-notification data, frozen at issue (direct debit only) */
  mandateReference?: string | null;
  creditorId?: string | null;
  /** a household invoice: its payment method comes from the payer's mandate, not from the member it is filed under */
  household?: boolean;
}

/**
 * How an issued invoice is paid now: the member's current method, except for household invoices, whose method was
 * fixed at issue from the payer (shared by the debit candidates and the run's re-check, so they never disagree).
 */
export function effectivePaymentMethod(snap: { paymentMethod?: string | null; household?: boolean } | null, recipientPersonId: string, memberPersonId: string | null, memberMethod: string | null) {
  const household = snap?.household || (memberPersonId !== null && recipientPersonId !== memberPersonId) || memberPersonId === null;
  return household ? (snap?.paymentMethod ?? memberMethod) : memberMethod;
}

export const RECEIVABLE_KINDS: InvoiceKind[] = ['membership', 'other', 'dunning_fee'];
/** Dunning fees are not dunned themselves. */
export const DUNNABLE_KINDS: InvoiceKind[] = ['membership', 'other'];

export function personLines(p: { kind: string; first_name: string | null; last_name: string | null; company_name: string | null; street: string | null; postal_code: string | null; city: string | null; country: string }) {
  const name = p.kind === 'organisation' ? (p.company_name ?? '') : [p.first_name, p.last_name].filter(Boolean).join(' ');
  const lines = [name, p.street, [p.postal_code, p.city].filter(Boolean).join(' '), p.country !== 'DE' ? p.country : null].filter((l): l is string => !!l);
  return { name, lines };
}

/**
 * Issues a draft: assigns the next gapless number in this transaction, freezes recipient and letterhead,
 * fixes the total from the lines and opens the receivable. Content is immutable afterwards (DB trigger).
 */
export async function issueInvoice(tx: Db, organizationId: string, invoiceId: string, issueDate: string, dueDate?: string | null, opts: { paymentMethod?: PaymentMethod; household?: boolean } = {}) {
  const inv = await tx.selectFrom('invoice').selectAll().where('id', '=', invoiceId).where('organization_id', '=', organizationId).forUpdate().executeTakeFirstOrThrow();
  if (inv.status !== 'draft') throw new Problem(409, 'not-draft', 'Die Rechnung ist bereits ausgestellt.');
  const lines = await tx.selectFrom('invoice_line').select(['total_cents', 'tax_rate']).where('invoice_id', '=', inv.id).execute();
  if (lines.length === 0) throw new Problem(400, 'no-lines', 'Eine Rechnung braucht mindestens eine Position.');
  const due = dueDate ?? inv.due_date;
  if (due && due < issueDate && inv.kind !== 'cancellation') throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'dueDate', message: 'Die Fälligkeit liegt vor dem Rechnungsdatum.' }] });
  const total = lines.reduce((s, l) => s + l.total_cents, 0);
  const org = await tx.selectFrom('organization').selectAll().where('id', '=', organizationId).executeTakeFirstOrThrow();
  // A small business (§ 19 UStG) shows no VAT: PDF, e-invoice and the booking must all agree on 0 %.
  if (org.small_business && lines.some((l) => Number(l.tax_rate) > 0)) throw new Problem(400, 'validation', 'Als Kleinunternehmer (§ 19 UStG) weist der Verein keine Umsatzsteuer aus.', 'Setze den Steuersatz aller Positionen auf 0 %.', { errors: [{ field: 'lines', message: 'Steuersatz muss 0 % sein.' }] });
  const person = await tx.selectFrom('person').selectAll().where('id', '=', inv.recipient_person_id).executeTakeFirstOrThrow();
  const member = inv.member_id ? await tx.selectFrom('member').select(['membership_number', 'payment_method']).where('id', '=', inv.member_id).executeTakeFirst() : undefined;
  const mandate = await tx.selectFrom('sepa_mandate').select('reference').where('person_id', '=', inv.recipient_person_id).where('status', '=', 'active').executeTakeFirst();
  const cancels = inv.cancels_invoice_id ? await tx.selectFrom('invoice').select('number').where('id', '=', inv.cancels_invoice_id).executeTakeFirst() : undefined;

  const isCancellation = inv.kind === 'cancellation';
  const pattern = isCancellation ? org.cancellation_number_pattern : org.invoice_number_pattern;
  const taken = async (n: string) => !!(await tx.selectFrom('invoice').select('id').where('organization_id', '=', organizationId).where('number', '=', n).executeTakeFirst());
  const number = await nextNumber(tx, organizationId, isCancellation ? 'cancellation' : 'invoice', pattern, issueDate, taken);
  const snapshot: IssueSnapshot = {
    recipient: personLines(person),
    membershipNumber: member?.membership_number ?? null,
    org: { name: org.name, street: org.street, postalCode: org.postal_code, city: org.city, email: org.email, iban: org.iban, bic: org.bic, bankName: org.bank_name, isDemo: org.is_demo, smallBusiness: org.small_business },
    paymentMethod: opts.paymentMethod ?? member?.payment_method ?? null,
    cancelsNumber: cancels?.number ?? null,
    mandateReference: mandate?.reference ?? null,
    creditorId: org.creditor_id,
    ...(opts.household ? { household: true } : {}),
  };
  const status = isCancellation ? 'issued' : total === 0 ? 'paid' : 'open';
  const dueOn = isCancellation ? null : (due ?? addDays(issueDate, org.payment_terms_days));
  // Cover and closing texts: the invoice's own, else the club's defaults (not on cancellations); placeholders are filled now and frozen.
  // Filled before the e-invoice, so the XML carries the same text as the PDF.
  const values = {
    vorname: person.first_name ?? person.company_name ?? '',
    name: snapshot.recipient.name,
    mitgliedsnummer: member?.membership_number ?? '',
    rechnungsnummer: number,
    betrag: (Math.abs(total) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }),
    faellig: dueOn ? formatDate(dueOn) : '',
    verein: org.name,
  };
  const textOf = (own: string | null, template: string | null) => {
    const t = own ?? (isCancellation ? null : template);
    return t ? fillInvoiceText(t, values) : null;
  };
  const coverText = textOf(inv.cover_text, org.invoice_cover_template);
  const closingText = textOf(inv.closing_text, org.invoice_closing_template);
  // E-invoice for recipients that asked for one: created once at issue, refused with the missing fields named.
  // A cancellation follows its original invoice (e-invoiced or not), not the recipient's current setting.
  const wantsEinvoice = isCancellation
    ? !!(inv.cancels_invoice_id && (await tx.selectFrom('invoice_einvoice').select('invoice_id').where('invoice_id', '=', inv.cancels_invoice_id).executeTakeFirst()))
    : person.einvoice_format === 'xrechnung';
  if (wantsEinvoice) {
    const linesFull = await tx.selectFrom('invoice_line').leftJoin('assessment', 'assessment.id', 'invoice_line.assessment_id').select(['invoice_line.text', 'invoice_line.quantity', 'invoice_line.total_cents', 'invoice_line.tax_rate', 'assessment.period_start', 'assessment.period_end']).where('invoice_line.invoice_id', '=', inv.id).orderBy('invoice_line.position').execute();
    const debit = snapshot.paymentMethod === 'direct_debit' && snapshot.mandateReference && org.creditor_id ? await tx.selectFrom('sepa_mandate').select('iban_encrypted').where('reference', '=', snapshot.mandateReference).where('person_id', '=', person.id).executeTakeFirst() : undefined;
    const x: Omit<XInvoice, 'lines'> = {
      number, typeCode: inv.kind === 'credit_note' || isCancellation ? '381' : '380', issueDate, dueDate: isCancellation ? null : (dueDate ?? inv.due_date ?? addDays(issueDate, org.payment_terms_days)), precedingNumber: cancels?.number ?? null, note: coverText,
      seller: { name: org.name, street: org.street ?? '', postalCode: org.postal_code ?? '', city: org.city ?? '', country: 'DE', vatId: org.vat_id, taxNumber: org.tax_number, registerNumber: org.register_number, contactName: org.einvoice_contact_name ?? '', contactPhone: org.einvoice_contact_phone ?? '', contactEmail: org.email ?? '', smallBusiness: org.small_business },
      buyer: { name: snapshot.recipient.name, street: person.street ?? '', postalCode: person.postal_code ?? '', city: person.city ?? '', country: person.country, reference: person.buyer_reference ?? '', address: person.einvoice_address ?? '', vatId: person.vat_id },
      payment: debit && !isCancellation && inv.kind !== 'credit_note' ? { kind: 'direct_debit', mandateReference: snapshot.mandateReference!, creditorId: org.creditor_id!, debtorIban: decrypt(debit.iban_encrypted) } : { kind: 'transfer', iban: org.iban ?? '', bic: org.bic, accountName: org.name },
    };
    const missing = missingFields(x);
    if (missing.length) throw new Problem(409, 'einvoice-missing', `Für die E-Rechnung (XRechnung) an ${snapshot.recipient.name} fehlen Angaben.`, `Es fehlt: ${missing.join('; ')}.`, { missing, recipient: snapshot.recipient.name });
    const xml = Buffer.from(xrechnungCii({ ...x, lines: linesFull.map((l) => ({ text: l.text, quantity: Number(l.quantity), grossCents: Number(l.total_cents), ratePct: Number(l.tax_rate), periodStart: l.period_start, periodEnd: l.period_end })) }), 'utf8');
    // Stored encrypted: a direct-debit XML holds the payer's full IBAN. The hash is of the plain XML.
    await tx.insertInto('invoice_einvoice').values({ invoice_id: inv.id, organization_id: organizationId, format: 'xrechnung-cii', xml: encryptBytes(xml), sha256: createHash('sha256').update(xml).digest('hex') }).execute();
  }
  await tx
    .updateTable('invoice')
    .set({
      number,
      status,
      recipient: JSON.stringify(snapshot),
      issue_date: issueDate,
      due_date: dueOn,
      total_cents: total,
      cover_text: coverText,
      closing_text: closingText,
      issued_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', inv.id)
    .execute();
  return { number, total };
}

/** Recomputes the paid amount from confirmed allocations and derives the payment status. */
export async function refreshPayment(tx: Db, invoiceId: string) {
  const inv = await tx.selectFrom('invoice').select(['id', 'status', 'total_cents']).where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
  const { paid, writeOff } = await tx
    .selectFrom('allocation')
    .select([sql<number>`coalesce(sum(amount_cents), 0)::bigint`.as('paid'), sql<number>`coalesce(sum(amount_cents) filter (where method = 'write_off'), 0)::bigint`.as('writeOff')])
    .where('invoice_id', '=', invoiceId)
    .where('status', '=', 'confirmed')
    .executeTakeFirstOrThrow();
  if (inv.status === 'cancelled' || inv.status === 'issued' || inv.status === 'draft') return;
  const status = writeOff > 0 && paid >= inv.total_cents ? 'written_off' : paid >= inv.total_cents ? 'paid' : paid > 0 ? 'partially_paid' : 'open';
  await tx.updateTable('invoice').set({ paid_cents: paid, status, updated_at: new Date() }).where('id', '=', invoiceId).execute();
}

/**
 * Returns the stored PDF, rendering it once from the issue snapshot on first request. The bytes never
 * change afterwards (the DB refuses a second write), so every download returns the same file.
 */
export async function storedPdf(db: Db, organizationId: string, invoiceId: string) {
  const inv = await db.selectFrom('invoice').selectAll().where('id', '=', invoiceId).where('organization_id', '=', organizationId).executeTakeFirst();
  if (!inv) throw new Problem(404, 'not-found', 'Rechnung nicht gefunden.');
  if (inv.status === 'draft' || !inv.number || !inv.issue_date) throw new Problem(409, 'not-issued', 'Entwürfe haben noch kein PDF.');
  if (inv.pdf) return { pdf: inv.pdf, number: inv.number };

  const snap = inv.recipient as IssueSnapshot;
  const lines = await db.selectFrom('invoice_line').selectAll().where('invoice_id', '=', inv.id).orderBy('position').execute();
  const titles: Record<InvoiceKind, string> = { membership: 'Beitragsrechnung', other: 'Rechnung', credit_note: 'Gutschrift', cancellation: 'Stornorechnung', dunning_fee: 'Mahngebühr' };
  const receivable = RECEIVABLE_KINDS.includes(inv.kind);
  const amount = euroText(inv.total_cents);
  let paymentText: string;
  if (inv.kind === 'cancellation') paymentText = `Diese Stornorechnung hebt die Rechnung ${snap.cancelsNumber ?? ''} vollständig auf. Ein bereits gezahlter Betrag wird erstattet oder verrechnet.`;
  else if (inv.kind === 'credit_note') paymentText = `Wir erstatten Dir ${amount}.`;
  else if (snap.paymentMethod === 'direct_debit' && snap.mandateReference) {
    // SEPA pre-notification on the invoice: amount, earliest collection date, mandate reference, creditor ID.
    paymentText = `Den Betrag von ${amount} ziehen wir frühestens am ${formatDate(inv.due_date)} per SEPA-Lastschrift von Deinem Konto ein. Mandatsreferenz ${snap.mandateReference}, Gläubiger-ID ${snap.creditorId ?? ''}. Bitte sorge für Deckung.`;
  } else if (snap.paymentMethod === 'direct_debit') paymentText = `Den Betrag von ${amount} ziehen wir per SEPA-Lastschrift ein, sobald Dein Mandat vorliegt.`;
  else if (snap.org.iban) paymentText = `Bitte überweise ${amount} bis zum ${formatDate(inv.due_date)} auf unser Konto ${formatIban(snap.org.iban)}${snap.org.bic ? ` (BIC ${snap.org.bic})` : ''}. Verwendungszweck: ${inv.number}.`;
  else paymentText = `Bitte zahle ${amount} bis zum ${formatDate(inv.due_date)}. Verwendungszweck: ${inv.number}.`;
  const epc = receivable && snap.paymentMethod !== 'direct_debit' && snap.org.iban && inv.total_cents > 0
    ? epcPayload({ name: snap.org.name, iban: snap.org.iban, bic: snap.org.bic, amountCents: inv.total_cents, remittance: inv.number })
    : null;

  const pdf = await renderInvoicePdf({
    title: inv.kind === 'cancellation' && snap.cancelsNumber ? `Stornorechnung zu ${snap.cancelsNumber}:` : titles[inv.kind],
    number: inv.number,
    issueDate: inv.issue_date,
    dueDate: receivable ? inv.due_date : null,
    membershipNumber: snap.membershipNumber,
    recipientLines: snap.recipient.lines,
    coverText: inv.cover_text,
    closingText: inv.closing_text,
    lines: lines.map((l) => ({ text: l.text, quantity: Number(l.quantity), unitCents: l.unit_cents, totalCents: l.total_cents, taxRate: Number(l.tax_rate) })),
    totalCents: inv.total_cents,
    negative: inv.kind === 'cancellation' || inv.kind === 'credit_note',
    paymentText,
    epc,
    org: snap.org,
    demo: snap.org.isDemo,
  });
  const sha = createHash('sha256').update(pdf).digest('hex');
  // Only the first writer stores its bytes; a parallel first download reads the winner's file.
  await db.updateTable('invoice').set({ pdf, pdf_sha256: sha }).where('id', '=', inv.id).where('pdf', 'is', null).execute();
  const stored = await db.selectFrom('invoice').select(['pdf']).where('id', '=', inv.id).executeTakeFirstOrThrow();
  return { pdf: stored.pdf!, number: inv.number };
}

const euroText = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/** Creates a draft invoice with lines. Quantities may be fractional (e.g. 1.5 hours); totals round to cents. */
export async function createDraft(
  tx: Db,
  v: { organizationId: string; kind: InvoiceKind; personId: string; memberId: string | null; dueDate?: string | null; coverText?: string | null; closingText?: string | null; feeRunId?: string | null; cancelsInvoiceId?: string | null; createdBy: string | null },
  lines: { text: string; quantity: number; unitCents: number; taxRate: number; net?: boolean; assessmentId?: string | null; discount?: boolean }[],
) {
  const inv = await tx
    .insertInto('invoice')
    .values({
      organization_id: v.organizationId,
      kind: v.kind,
      recipient_person_id: v.personId,
      member_id: v.memberId,
      due_date: v.dueDate ?? null,
      cover_text: v.coverText ?? null,
      closing_text: v.closingText ?? null,
      fee_run_id: v.feeRunId ?? null,
      cancels_invoice_id: v.cancelsInvoiceId ?? null,
      created_by: v.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await insertLines(tx, v.organizationId, inv.id, lines);
  return inv.id;
}

/** Quantity × unit price in cents, exact: quantities have at most two decimals; half a cent rounds away from zero (like PostgreSQL round). */
export function lineTotal(quantity: number, unitCents: number) {
  const product = Math.round(quantity * 100) * unitCents;
  return Math.sign(product) * Math.floor((Math.abs(product) + 50) / 100);
}

export async function insertLines(tx: Db, organizationId: string, invoiceId: string, lines: { text: string; quantity: number; unitCents: number; taxRate: number; net?: boolean; assessmentId?: string | null; discount?: boolean }[]) {
  let position = 1;
  for (const l of lines) {
    const unitCents = l.net ? grossFromNet(l.unitCents, l.taxRate) : l.unitCents;
    await tx
      .insertInto('invoice_line')
      .values({
        organization_id: organizationId,
        invoice_id: invoiceId,
        position: position++,
        text: l.text,
        quantity: l.quantity,
        unit_cents: unitCents,
        total_cents: lineTotal(l.quantity, unitCents),
        tax_rate: l.taxRate,
        assessment_id: l.assessmentId ?? null,
        discount: l.discount ?? false,
      })
      .execute();
  }
}

/**
 * Cancels an issued receivable with a cancellation document (own number range, same lines) and frees
 * its assessments so the periods can be billed again. Refused while payments are allocated to it.
 */
export async function cancelInvoice(tx: Db, organizationId: string, invoiceId: string, issueDate: string, createdBy: string | null) {
  const inv = await tx.selectFrom('invoice').selectAll().where('id', '=', invoiceId).where('organization_id', '=', organizationId).forUpdate().executeTakeFirst();
  if (!inv) throw new Problem(404, 'not-found', 'Rechnung nicht gefunden.');
  if (!['open', 'partially_paid', 'paid', 'written_off'].includes(inv.status) || inv.kind === 'cancellation') {
    throw new Problem(409, 'not-cancellable', 'Nur ausgestellte Rechnungen lassen sich stornieren.');
  }
  // A cancellation is a negative document; cancelling a credit note would need a positive one, which does not exist yet.
  if (inv.kind === 'credit_note') throw new Problem(409, 'not-cancellable', 'Eine Gutschrift wird nicht storniert.', 'Stell stattdessen eine Rechnung über den Betrag aus.');
  await assertNotLive(tx, inv.id);
  const paid = await tx.selectFrom('allocation').select('method').where('invoice_id', '=', inv.id).where('status', '=', 'confirmed').executeTakeFirst();
  if (paid) {
    throw new Problem(409, 'has-payments', paid.method === 'write_off' ? 'Die Rechnung ist ausgebucht. Nimm die Ausbuchung zuerst zurück, dann kannst Du stornieren.' : 'Auf die Rechnung sind Zahlungen gebucht. Buche sie zuerst zurück, dann kannst Du stornieren.');
  }
  const lines = await tx.selectFrom('invoice_line').selectAll().where('invoice_id', '=', inv.id).orderBy('position').execute();
  const cancelId = await createDraft(
    tx,
    { organizationId, kind: 'cancellation', personId: inv.recipient_person_id, memberId: inv.member_id, cancelsInvoiceId: inv.id, feeRunId: inv.fee_run_id, createdBy },
    lines.map((l) => ({ text: l.text, quantity: Number(l.quantity), unitCents: l.unit_cents, taxRate: Number(l.tax_rate), discount: l.discount })),
  );
  const issued = await issueInvoice(tx, organizationId, cancelId, issueDate);
  await tx.updateTable('invoice').set({ status: 'cancelled', updated_at: new Date() }).where('id', '=', inv.id).execute();
  const assessmentIds = lines.map((l) => l.assessment_id).filter((x): x is string => !!x);
  if (assessmentIds.length) await tx.updateTable('assessment').set({ status: 'cancelled' }).where('id', 'in', assessmentIds).execute();
  return { cancellationId: cancelId, number: issued.number };
}
