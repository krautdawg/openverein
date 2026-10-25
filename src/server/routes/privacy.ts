import { createRequire } from 'node:module';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import { z } from 'zod';
import { CONSENT_PURPOSE_LABEL, consent, consentInput, privacyState, reviewItem } from '../../shared/privacy.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { zip } from '../exports/zip.ts';
import { customText } from '../../shared/customFields.ts';
import { anonymise, anonymiseBlockers, recordErasureFile } from '../gdpr/service.ts';
import { notFound, Problem } from '../http/problem.ts';
import { emailHash } from '../mail/worker.ts';
import { orgToday } from '../members/query.ts';
import { requireClubWide, requireStepUp } from '../policy.ts';

const tags = ['privacy'];
const idParam = z.object({ id: z.uuid() });
const require = createRequire(import.meta.url);
const FONT = require.resolve('source-sans/TTF/SourceSans3-Regular.ttf');
const FONT_BOLD = require.resolve('source-sans/TTF/SourceSans3-Semibold.ttf');

type Row = Record<string, unknown>;

/** A plain, readable PDF of the export: one heading per section, one line per record. */
function exportPdf(title: string, sections: [string, Row[]][]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.font('bold').fontSize(15).text(title).moveDown(0.3);
  doc.font('text').fontSize(9).fillColor('#5f6874').text(`Erstellt am ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}. Die maschinenlesbare Fassung steht in daten.json.`).fillColor('#14202e').moveDown(0.8);
  for (const [name, rows] of sections) {
    doc.font('bold').fontSize(11.5).text(name).moveDown(0.2);
    if (!rows.length) doc.font('text').fontSize(9.5).fillColor('#5f6874').text('Keine Einträge.').fillColor('#14202e');
    for (const r of rows) {
      const line = Object.entries(r).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
      doc.font('text').fontSize(9.5).text(line, { paragraphGap: 3 });
    }
    doc.moveDown(0.6);
  }
  doc.end();
  return done;
}

export const privacyRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function personOf(organizationId: string, id: string) {
    const p = await db.selectFrom('person').selectAll().where('id', '=', id).where('organization_id', '=', organizationId).executeTakeFirst();
    if (!p) throw notFound('Person');
    return p;
  }
  const consentDto = (c: { id: string; purpose: z.infer<typeof consent>['purpose']; label: string | null; source: z.infer<typeof consent>['source']; text_version: string | null; granted_at: Date; withdrawn_at: Date | null; withdrawn_source: z.infer<typeof consent>['source'] | null }) => ({
    id: c.id, purpose: c.purpose, label: c.label, source: c.source, textVersion: c.text_version, grantedAt: c.granted_at.toISOString(), withdrawnAt: c.withdrawn_at?.toISOString() ?? null, withdrawnSource: c.withdrawn_source,
  });

  app.get('/persons/:id/privacy', { schema: { tags, summary: 'Datenschutz einer Person: Einwilligungen, Löschsperre, was eine Anonymisierung verhindert', params: idParam, response: { 200: privacyState } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const p = await personOf(actor.organizationId, req.params.id);
    const consents = await db.selectFrom('consent').selectAll().where('person_id', '=', p.id).orderBy('granted_at', 'desc').execute();
    return { consents: consents.map(consentDto), legalHoldReason: p.legal_hold_reason, anonymisedAt: p.anonymised_at?.toISOString() ?? null, blockers: await anonymiseBlockers(db, actor.organizationId, p.id) };
  });

  app.post('/persons/:id/consents', { schema: { tags, summary: 'Einwilligung erfassen (ersetzt keine laufende für denselben Zweck)', params: idParam, body: consentInput, response: { 201: consent } } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    const p = await personOf(actor.organizationId, req.params.id);
    if (p.anonymised_at) throw new Problem(409, 'anonymised', 'Diese Person ist anonymisiert.');
    const b = req.body;
    if (b.purpose === 'other' && !b.label) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'label', message: 'Bitte beschreiben, wofür die Einwilligung gilt.' }] });
    const c = await db.transaction().execute(async (tx) => {
      const c = await tx.insertInto('consent').values({ organization_id: actor.organizationId, person_id: p.id, purpose: b.purpose, label: b.purpose === 'other' ? b.label! : null, source: b.source, text_version: b.textVersion ?? null, created_by: actor.userId }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'consent.granted', entityType: 'person', entityId: p.id, diff: { purpose: [null, b.purpose], source: [null, b.source] } });
      return c;
    });
    reply.status(201);
    return consentDto(c);
  });

  app.post('/consents/:id/withdraw', { schema: { tags, summary: 'Einwilligung widerrufen (Zeitpunkt und Weg werden gespeichert)', params: idParam, body: z.object({ source: consentInput.shape.source }), response: { 200: consent } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    const c = await db.transaction().execute(async (tx) => {
      const c = await tx.selectFrom('consent').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!c) throw notFound('Einwilligung');
      if (c.withdrawn_at) throw new Problem(409, 'withdrawn', 'Diese Einwilligung ist schon widerrufen.');
      const u = await tx.updateTable('consent').set({ withdrawn_at: new Date(), withdrawn_source: req.body.source }).where('id', '=', c.id).returningAll().executeTakeFirstOrThrow();
      if (c.purpose === 'newsletter') {
        const p = await tx.selectFrom('person').select('email').where('id', '=', c.person_id).executeTakeFirstOrThrow();
        if (p.email) await tx.insertInto('suppression').values({ organization_id: actor.organizationId, email_hash: emailHash(p.email), reason: 'unsubscribe' }).onConflict((oc) => oc.doNothing()).execute();
      }
      await audit(tx, actor.organizationId, actor, { action: 'consent.withdrawn', entityType: 'person', entityId: c.person_id, diff: { purpose: [c.purpose, null], source: [null, req.body.source] } });
      return u;
    });
    return consentDto(c);
  });

  app.put('/persons/:id/legal-hold', { schema: { tags, summary: 'Löschsperre setzen oder aufheben (blockiert Anonymisierung)', params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300).nullable() }), response: { 200: z.object({ legalHoldReason: z.string().nullable() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    const p = await personOf(actor.organizationId, req.params.id);
    if (p.anonymised_at) throw new Problem(409, 'anonymised', 'Diese Person ist anonymisiert.');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('person').set({ legal_hold_reason: req.body.reason, updated_at: new Date() }).where('id', '=', p.id).execute();
      await audit(tx, actor.organizationId, actor, { action: req.body.reason ? 'person.legal_hold' : 'person.legal_hold_released', entityType: 'person', entityId: p.id, diff: { reason: [p.legal_hold_reason, req.body.reason] } });
    });
    return { legalHoldReason: req.body.reason };
  });

  app.post('/persons/:id/anonymise', { schema: { tags, summary: 'Person anonymisieren (endgültig; Rechnungen und Buchungen behalten ihre Angaben bis zum Ende ihrer Aufbewahrung)', params: idParam, body: z.object({}).optional(), response: { 200: privacyState } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'write');
    requireStepUp(actor);
    await db.transaction().execute(async (tx) => {
      // Lock the person first, then check: parallel invoices or mandates for this person wait or are seen.
      if (!(await tx.selectFrom('person').select('id').where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst())) throw notFound('Person');
      const blockers = await anonymiseBlockers(tx, actor.organizationId, req.params.id);
      if (blockers.length) throw new Problem(409, 'anonymise-blocked', 'Anonymisieren ist gerade nicht möglich.', blockers.join(' '), { blockers });
      await anonymise(tx, actor.organizationId, req.params.id);
      await audit(tx, actor.organizationId, actor, { action: 'person.anonymised', entityType: 'person', entityId: req.params.id });
    });
    // The database log is authoritative; a failed append is repaired at the next start.
    await recordErasureFile(actor.organizationId, req.params.id).catch((err) => req.log.error({ err }, 'erasure file append failed'));
    return { consents: [], legalHoldReason: null, anonymisedAt: new Date().toISOString(), blockers: ['Schon anonymisiert.'] };
  });

  app.get('/persons/:id/export', { schema: { tags, summary: 'Auskunft nach Art. 15 DSGVO: ZIP mit daten.json und auskunft.pdf; der Abruf wird protokolliert', params: idParam } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const p = await personOf(actor.organizationId, req.params.id);
    const members = await db.selectFrom('member').selectAll().where('person_id', '=', p.id).execute();
    const memberIds = members.map((m) => m.id).concat(['00000000-0000-0000-0000-000000000000']);
    const q = <T>(rows: Promise<T[]>) => rows;
    const [groups, consents, invoices, mandates, donations, receipts, events, mails, changes, applications, files, contacts, offers] = await Promise.all([
      q(db.selectFrom('group_membership').innerJoin('club_group', 'club_group.id', 'group_membership.group_id').select(['club_group.name as Gruppe', 'group_membership.member_id']).where('group_membership.member_id', 'in', memberIds).execute()),
      q(db.selectFrom('consent').selectAll().where('person_id', '=', p.id).execute()),
      q(db.selectFrom('invoice').select(['number as Nummer', 'kind as Art', 'issue_date as Datum', 'total_cents as Betrag_Cent', 'paid_cents as Bezahlt_Cent', 'status as Status']).where('recipient_person_id', '=', p.id).where('status', '<>', 'draft').execute()),
      q(db.selectFrom('sepa_mandate').select(['reference as Referenz', 'signed_on as Unterschrieben', 'account_holder as Kontoinhaber', 'iban_last4 as IBAN_Ende', 'status as Status', 'last_collected_on as Letzter_Einzug']).where('person_id', '=', p.id).execute()),
      q(db.selectFrom('donation').select(['donated_on as Datum', 'amount_cents as Betrag_Cent', 'waiver as Aufwandsspende']).where('person_id', '=', p.id).execute()),
      q(db.selectFrom('donation_receipt').select(['number as Nummer', 'issued_on as Ausgestellt', 'total_cents as Betrag_Cent', 'status as Status']).where('person_id', '=', p.id).execute()),
      q(db.selectFrom('participation').innerJoin('event', 'event.id', 'participation.event_id').select(['event.title as Termin', 'participation.occurrence_date as Datum', 'participation.status as Status']).where('participation.member_id', 'in', memberIds).execute()),
      q(db.selectFrom('delivery').innerJoin('message', 'message.id', 'delivery.message_id').select(['message.subject as Betreff', 'delivery.email as An', 'delivery.status as Status', 'delivery.sent_at as Gesendet']).where('delivery.person_id', '=', p.id).execute()),
      q(db.selectFrom('change_request').select(['field as Feld', sql<string>`case when field = 'iban' then '(IBAN, verschlüsselt gespeichert)' else new_value end`.as('Neu'), 'status as Status', 'requested_at as Angefragt']).where('person_id', '=', p.id).execute()),
      q(db.selectFrom('application').select(['application_date as Datum', 'payload as Angaben', 'consent as Einwilligung', 'status as Status']).where('member_id', 'in', memberIds).execute()),
      q(db.selectFrom('file').select(['name as Datei', 'created_at as Hochgeladen']).where('member_id', 'in', memberIds).where('superseded_at', 'is', null).execute()),
      // Private entries too: the right of access covers every note about the person.
      q(db.selectFrom('contact_log').select(['occurred_on as Datum', 'kind as Art', 'text as Notiz']).where('person_id', '=', p.id).orderBy('occurred_on').execute()),
      q(db.selectFrom('offer').select(['number as Nummer', 'issue_date as Datum', 'total_cents as Betrag_Cent', 'status as Status']).where('person_id', '=', p.id).where('status', '<>', 'draft').execute()),
    ]);
    const auditRows = await db.selectFrom('audit_event').select(['at as Zeit', 'action as Aktion', 'actor_label as Von', 'diff as Änderung']).where('organization_id', '=', actor.organizationId).where('entity_id', 'in', [p.id, ...memberIds]).orderBy('id').execute();
    const sections: [string, Row[]][] = [
      ['Stammdaten', [{ Vorname: p.first_name, Nachname: p.last_name, Firma: p.company_name, Geburtsdatum: p.birth_date, 'E-Mail': p.email, Telefon: p.phone, Straße: p.street, PLZ: p.postal_code, Ort: p.city, Land: p.country, Notiz: p.note }]],
      // Archived fields included: their values are still stored.
      ['Weitere Angaben', [Object.fromEntries((await db.selectFrom('custom_field').select(['id', 'label', 'type']).where('organization_id', '=', actor.organizationId).orderBy('position').execute()).filter((f) => p.custom[f.id] !== undefined).map((f) => [f.label, customText(f.type, p.custom[f.id])]))]],
      ['Mitgliedschaften', members.map((m) => ({ Nummer: m.membership_number, Status: m.status, Antrag: m.application_date, Eintritt: m.join_date, Kündigung: m.notice_date, Austritt: m.exit_date, Zahlweise: m.payment_method }))],
      ['Gruppen', groups.map(({ member_id: _m, ...g }) => g)],
      ['Einwilligungen', consents.map((c) => ({ Zweck: c.label ?? CONSENT_PURPOSE_LABEL[c.purpose], Quelle: c.source, Text: c.text_version, Erteilt: c.granted_at.toISOString(), Widerrufen: c.withdrawn_at?.toISOString() ?? null }))],
      ['Rechnungen', invoices as Row[]],
      ['Angebote', offers as Row[]],
      ['SEPA-Mandate', mandates as Row[]],
      ['Spenden', donations as Row[]],
      ['Zuwendungsbestätigungen', receipts as Row[]],
      ['Termine', events as Row[]],
      ['E-Mails', mails as Row[]],
      ['Änderungswünsche', changes as Row[]],
      ['Anträge', applications as Row[]],
      ['Dateien', files as Row[]],
      ['Kontaktverlauf', contacts as Row[]],
      ['Protokoll', auditRows as Row[]],
    ];
    const title = `Auskunft über gespeicherte Daten: ${p.company_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ')}`;
    const json = Buffer.from(JSON.stringify(Object.fromEntries(sections), null, 2), 'utf8');
    const file = zip([{ name: 'daten.json', data: json }, { name: 'auskunft.pdf', data: await exportPdf(title, sections) }]);
    await audit(db, actor.organizationId, actor, { action: 'person.exported', entityType: 'person', entityId: p.id });
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="Auskunft-${p.id.slice(0, 8)}.zip"`).send(file);
  });

  app.get('/privacy/review', { schema: { tags, summary: 'Ehemalige, deren Austritt länger als die Löschfrist zurückliegt (zur Prüfung, nichts wird ohne Klick gelöscht)', response: { 200: z.object({ eraseAfterMonths: z.number(), items: z.array(reviewItem) }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'members', 'read');
    const org = await db.selectFrom('organization').select('erase_after_months').where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
    const today = await orgToday(db, actor.organizationId);
    const rows = await sql<{ person_id: string; first_name: string | null; last_name: string | null; company_name: string | null; kind: string; exit_date: string }>`
      select p.id as person_id, p.first_name, p.last_name, p.company_name, p.kind, coalesce(max(m.exit_date), max(m.updated_at)::date)::text as exit_date
      from person p join member m on m.person_id = p.id
      where p.organization_id = ${actor.organizationId} and p.anonymised_at is null
      group by p.id
      -- Rejected applicants have no exit date: their last change counts.
      having bool_and(m.status in ('former', 'rejected')) and coalesce(max(m.exit_date), max(m.updated_at)::date) + make_interval(months => ${org.erase_after_months}) < ${today}::date
      order by 6
      limit 100`.execute(db);
    const items = [];
    for (const r of rows.rows) {
      items.push({ personId: r.person_id, name: r.kind === 'organisation' ? (r.company_name ?? '') : [r.last_name, r.first_name].filter(Boolean).join(', '), exitDate: r.exit_date, blockers: await anonymiseBlockers(db, actor.organizationId, r.person_id) });
    }
    return { eraseAfterMonths: org.erase_after_months, items };
  });

  app.put('/privacy/settings', { schema: { tags, summary: 'Löschfrist nach Austritt (Monate)', body: z.object({ eraseAfterMonths: z.number().int().min(1).max(240) }), response: { 200: z.object({ eraseAfterMonths: z.number() }) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'settings', 'write');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('organization').set({ erase_after_months: req.body.eraseAfterMonths, updated_at: new Date() }).where('id', '=', actor.organizationId).execute();
      await audit(tx, actor.organizationId, actor, { action: 'privacy.settings', entityType: 'organization', entityId: actor.organizationId, diff: { eraseAfterMonths: [null, req.body.eraseAfterMonths] } });
    });
    return req.body;
  });
};
