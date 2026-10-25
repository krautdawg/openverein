import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import { buchungsstapel, pairLines, type DatevLine } from '../exports/datev.ts';
import { cp1252, zip } from '../exports/zip.ts';
import { notFound, Problem } from '../http/problem.ts';
import { syncAllocations } from '../ledger/service.ts';
import { requireClubWide } from '../policy.ts';

const tags = ['ledger'];

const datevSettings = z.object({ consultant: z.number().int().min(1001).max(9_999_999).nullable(), client: z.number().int().min(1).max(99_999).nullable(), accountLength: z.number().int().min(4).max(8), fiscalYearStartMonth: z.number().int().min(1).max(12) });
const exportDto = z.object({ id: z.uuid(), mode: z.enum(['delta', 'full']), from: z.string(), to: z.string(), entryCount: z.number(), sha256: z.string(), createdAt: z.string() });

const csvCell = (v: string | number | null) => (typeof v === 'number' ? String(v) : `"${(v ?? '').replace(/"/g, '""')}"`);
const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const de = (d: string) => d.split('-').reverse().join('.');
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const exportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  app.get('/ledger/datev-settings', { schema: { tags, summary: 'DATEV-Kopfdaten (Beraternummer, Mandantennummer, Kontenlänge, Wirtschaftsjahr)', response: { 200: datevSettings } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    const s = await db.selectFrom('ledger_setting').selectAll().where('organization_id', '=', actor.organizationId).executeTakeFirst();
    return { consultant: s?.datev_consultant ?? null, client: s?.datev_client ?? null, accountLength: s?.datev_account_length ?? 4, fiscalYearStartMonth: s?.fiscal_year_start_month ?? 1 };
  });

  app.put('/ledger/datev-settings', { schema: { tags, summary: 'DATEV-Kopfdaten speichern', body: datevSettings, response: { 200: datevSettings } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'write');
    const b = req.body;
    await db.transaction().execute(async (tx) => {
      await sql`select ov_seed_ledger(${actor.organizationId}::uuid)`.execute(tx);
      await tx.updateTable('ledger_setting').set({ datev_consultant: b.consultant, datev_client: b.client, datev_account_length: b.accountLength, fiscal_year_start_month: b.fiscalYearStartMonth }).where('organization_id', '=', actor.organizationId).execute();
      await audit(tx, actor.organizationId, actor, { action: 'ledger.datev_settings', entityType: 'organization', entityId: actor.organizationId });
    });
    return b;
  });

  app.get('/ledger/exports', { schema: { tags, summary: 'Bisherige DATEV-Exporte', response: { 200: z.array(exportDto) } } }, async (req) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    const rows = await db.selectFrom('datev_export').select(['id', 'mode', 'period_from', 'period_to', 'entry_count', 'sha256', 'created_at']).where('organization_id', '=', actor.organizationId).orderBy('created_at', 'desc').execute();
    return rows.map((r) => ({ id: r.id, mode: r.mode, from: r.period_from, to: r.period_to, entryCount: r.entry_count, sha256: r.sha256, createdAt: r.created_at.toISOString() }));
  });

  app.post(
    '/ledger/exports/datev',
    { schema: { tags, summary: 'DATEV-Buchungsstapel (EXTF 700) als ZIP erzeugen: neue Buchungen seit dem letzten Export oder alle eines Zeitraums', body: z.object({ from: z.iso.date(), to: z.iso.date(), mode: z.enum(['delta', 'full']).default('delta') }), response: { 201: exportDto } } },
    async (req, reply) => {
      const actor = requireActor(req);
      requireClubWide(actor, 'ledger', 'write');
      const { from, to, mode } = req.body;
      if (to < from) throw new Problem(400, 'validation', 'Das Ende liegt vor dem Anfang.');
      await syncAllocations(db, actor.organizationId);
      const s = await db.selectFrom('ledger_setting').selectAll().where('organization_id', '=', actor.organizationId).executeTakeFirst();
      if (!s?.datev_consultant || !s.datev_client) throw new Problem(409, 'datev-settings', 'Beraternummer und Mandantennummer fehlen.', 'Trag sie unter Buchhaltung → Einstellungen ein.');
      let q = db.selectFrom('journal_entry').selectAll().where('organization_id', '=', actor.organizationId).where('entry_date', '>=', from).where('entry_date', '<=', to);
      if (mode === 'delta') q = q.where((eb) => eb.not(eb.exists(eb.selectFrom('datev_export_entry').select('datev_export_entry.entry_id').whereRef('datev_export_entry.entry_id', '=', 'journal_entry.id'))));
      const entries = await q.orderBy('entry_date').orderBy('number').execute();
      if (!entries.length) throw new Problem(409, 'nothing', mode === 'delta' ? 'Seit dem letzten Export gibt es keine neuen Buchungen im Zeitraum.' : 'Keine Buchungen im Zeitraum.');
      const lines = await db
        .selectFrom('journal_line')
        .innerJoin('ledger_account', 'ledger_account.id', 'journal_line.account_id')
        .leftJoin('cost_center', 'cost_center.id', 'journal_line.cost_center_id')
        .select(['journal_line.entry_id', 'ledger_account.number', 'ledger_account.name', 'ledger_account.kind', 'ledger_account.datev_number', 'journal_line.debit_cents', 'journal_line.credit_cents', 'journal_line.sphere', 'cost_center.code as cc'])
        .where('journal_line.entry_id', 'in', entries.map((e) => e.id))
        .execute();
      // Refuse while any used account has no DATEV number, and say which.
      const missing = [...new Map(lines.filter((l) => !l.datev_number).map((l) => [l.number, `${l.number} ${l.name}`])).values()];
      if (missing.length) throw new Problem(409, 'datev-mapping', 'Für den Export fehlen DATEV-Kontonummern.', `Ergänze sie im Kontenplan: ${missing.join(', ')}.`, { accounts: missing });
      const rows: DatevLine[] = [];
      for (const e of entries) {
        const own = lines.filter((l) => l.entry_id === e.id);
        for (const r of pairLines(own.map((l) => ({ account: l.datev_number!, debitCents: Number(l.debit_cents), creditCents: Number(l.credit_cents), sphere: l.sphere, costCenter: l.cc, isMoney: l.kind === 'money' })))) {
          rows.push({ entryNumber: e.number, date: e.entry_date, text: e.text, ...r });
        }
      }
      const fy = `${from.slice(0, 4)}-${String(s.fiscal_year_start_month).padStart(2, '0')}-01`;
      const csv = buchungsstapel({ consultant: s.datev_consultant, client: s.datev_client, fiscalYearStart: fy <= from ? fy : `${Number(from.slice(0, 4)) - 1}${fy.slice(4)}`, accountLength: s.datev_account_length, from, to, createdAt: new Date() }, rows);
      const file = zip([{ name: `EXTF_Buchungsstapel_${from}_${to}.csv`, data: cp1252(csv) }]);
      const sha = createHash('sha256').update(file).digest('hex');
      const ex = await db.transaction().execute(async (tx) => {
        const ex = await tx.insertInto('datev_export').values({ organization_id: actor.organizationId, mode, period_from: from, period_to: to, entry_count: entries.length, file, sha256: sha, created_by: actor.userId }).returningAll().executeTakeFirstOrThrow();
        await tx.insertInto('datev_export_entry').values(entries.map((e) => ({ export_id: ex.id, entry_id: e.id }))).execute();
        await audit(tx, actor.organizationId, actor, { action: 'ledger.datev_export', entityType: 'datev_export', entityId: ex.id, diff: { from: [null, from], to: [null, to], entries: [null, entries.length], mode: [null, mode] } });
        return ex;
      });
      reply.status(201);
      return { id: ex.id, mode: ex.mode, from: ex.period_from, to: ex.period_to, entryCount: ex.entry_count, sha256: ex.sha256, createdAt: ex.created_at.toISOString() };
    },
  );

  app.get('/ledger/exports/:id/file', { schema: { tags, summary: 'DATEV-Export herunterladen (immer dieselben Bytes)', params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const actor = requireActor(req);
    requireClubWide(actor, 'ledger', 'read');
    const ex = await db.selectFrom('datev_export').select(['file', 'period_from', 'period_to']).where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).executeTakeFirst();
    if (!ex) throw notFound('Export');
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="DATEV_${ex.period_from}_${ex.period_to}.zip"`).send(ex.file);
  });

  app.get(
    '/ledger/exports/z3',
    { schema: { tags, summary: 'Datenträgerüberlassung für die Betriebsprüfung (GoBD Z3, Beschreibungsstandard): index.xml und CSV-Tabellen eines Jahres; jeder Abruf wird protokolliert', querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }) } },
    async (req, reply) => {
      const actor = requireActor(req);
      requireClubWide(actor, 'ledger', 'read');
      await syncAllocations(db, actor.organizationId);
      const from = `${req.query.year}-01-01`;
      const to = `${req.query.year}-12-31`;
      const org = await db.selectFrom('organization').select(['name', 'city']).where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
      const entries = await db.selectFrom('journal_entry').selectAll().where('organization_id', '=', actor.organizationId).where('entry_date', '>=', from).where('entry_date', '<=', to).orderBy('number').execute();
      const reversed = new Map((await db.selectFrom('journal_entry').select(['id', 'number']).where('organization_id', '=', actor.organizationId).execute()).map((e) => [e.id, e.number]));
      const lines = entries.length ? await db.selectFrom('journal_line').innerJoin('ledger_account', 'ledger_account.id', 'journal_line.account_id').leftJoin('cost_center', 'cost_center.id', 'journal_line.cost_center_id').leftJoin('tax_rate', 'tax_rate.id', 'journal_line.tax_rate_id').select(['journal_line.entry_id', 'ledger_account.number', 'journal_line.debit_cents', 'journal_line.credit_cents', 'journal_line.sphere', 'cost_center.code as cc', 'tax_rate.label as rate', 'journal_line.text']).where('journal_line.entry_id', 'in', entries.map((e) => e.id)).execute() : [];
      const accounts = await db.selectFrom('ledger_account').selectAll().where('organization_id', '=', actor.organizationId).orderBy('number').execute();
      const invoices = await db.selectFrom('invoice').innerJoin('person', 'person.id', 'invoice.recipient_person_id').select(['invoice.number', 'invoice.kind', 'invoice.issue_date', 'invoice.total_cents', 'invoice.paid_cents', 'invoice.status', 'person.id as person', 'person.first_name', 'person.last_name', 'person.company_name']).where('invoice.organization_id', '=', actor.organizationId).where('invoice.issue_date', '>=', from).where('invoice.issue_date', '<=', to).orderBy('invoice.number').execute();
      const numberOf = new Map(entries.map((e) => [e.id, e.number]));
      const debtors = [...new Map(invoices.map((i) => [i.person, [i.person, i.company_name ?? [i.first_name, i.last_name].filter(Boolean).join(' ')]])).values()];

      const tables: { file: string; name: string; desc: string; key: string; columns: [string, 'num' | 'date' | 'text' | 'money'][]; rows: (string | number | null)[][] }[] = [
        { file: 'buchungen.csv', name: 'Buchungen', desc: 'Journal: eine Zeile je Buchung', key: 'Nr', columns: [['Nr', 'num'], ['Datum', 'date'], ['Text', 'text'], ['Herkunft', 'text'], ['StornoVon', 'num']], rows: entries.map((e) => [e.number, de(e.entry_date), e.text, e.source, e.reverses_id ? (reversed.get(e.reverses_id) ?? null) : null]) },
        { file: 'buchungszeilen.csv', name: 'Buchungszeilen', desc: 'Soll- und Haben-Zeilen je Buchung', key: 'Buchung', columns: [['Buchung', 'num'], ['Konto', 'text'], ['Soll', 'money'], ['Haben', 'money'], ['Sphaere', 'text'], ['Kostenstelle', 'text'], ['Steuersatz', 'text'], ['Text', 'text']], rows: lines.map((l) => [numberOf.get(l.entry_id)!, l.number, money(Number(l.debit_cents)), money(Number(l.credit_cents)), l.sphere, l.cc, l.rate, l.text]) },
        { file: 'konten.csv', name: 'Konten', desc: 'Kontenplan mit DATEV-Zuordnung', key: 'Konto', columns: [['Konto', 'text'], ['Name', 'text'], ['Art', 'text'], ['DATEV', 'text']], rows: accounts.map((a) => [a.number, a.name, a.kind, a.datev_number]) },
        { file: 'rechnungen.csv', name: 'Rechnungen', desc: 'Ausgangsrechnungen des Jahres', key: 'Nummer', columns: [['Nummer', 'text'], ['Art', 'text'], ['Datum', 'date'], ['Debitor', 'text'], ['Betrag', 'money'], ['Bezahlt', 'money'], ['Status', 'text']], rows: invoices.map((i) => [i.number, i.kind, i.issue_date ? de(i.issue_date) : null, i.person, money(Number(i.total_cents)), money(Number(i.paid_cents)), i.status]) },
        { file: 'debitoren.csv', name: 'Debitoren', desc: 'Rechnungsempfänger', key: 'Id', columns: [['Id', 'text'], ['Name', 'text']], rows: debtors },
      ];
      const files = tables.map((t) => ({ name: t.file, data: cp1252(t.rows.map((r) => r.map((c, i) => (t.columns[i]![1] === 'num' || t.columns[i]![1] === 'money' ? (c === null ? '' : String(c)) : csvCell(c as string | null))).join(';')).join('\r\n') + '\r\n') }));
      const col = ([n, type]: [string, string], primary: boolean) => {
        const tag = primary ? 'VariablePrimaryKey' : 'VariableColumn';
        const kind = type === 'num' ? '<Numeric/>' : type === 'money' ? '<Numeric><Accuracy>2</Accuracy></Numeric>' : type === 'date' ? '<Date><Format>DD.MM.YYYY</Format></Date>' : '<AlphaNumeric/>';
        return `        <${tag}><Name>${n}</Name>${kind}</${tag}>`;
      };
      const index = `<?xml version="1.0" encoding="ISO-8859-1"?>
<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier><Name>${xml(org.name)}</Name><Location>${xml(org.city ?? '')}</Location><Comment>OpenVerein, Geschäftsjahr ${req.query.year}</Comment></DataSupplier>
  <Media>
    <Name>Geschäftsjahr ${req.query.year}</Name>
${tables
  .map(
    (t) => `    <Table>
      <URL>${t.file}</URL>
      <Name>${t.name}</Name>
      <Description>${xml(t.desc)}</Description>
      <Validity><Range><From>${de(from)}</From><To>${de(to)}</To></Range></Validity>
      <DecimalSymbol>,</DecimalSymbol>
      <DigitGroupingSymbol>.</DigitGroupingSymbol>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter>
        <RecordDelimiter>&#13;&#10;</RecordDelimiter>
        <TextEncapsulator>"</TextEncapsulator>
${t.columns.map((c, i) => col(c, i === 0 && t.columns[0]![0] === t.key)).join('\n')}
      </VariableLength>
    </Table>`,
  )
  .join('\n')}
  </Media>
</DataSet>
`;
      const file = zip([{ name: 'index.xml', data: cp1252(index) }, ...files]);
      await audit(db, actor.organizationId, actor, { action: 'ledger.z3_export', entityType: 'organization', entityId: actor.organizationId, diff: { year: [null, req.query.year], sha256: [null, createHash('sha256').update(file).digest('hex')] } });
      return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="GoBD_Z3_${req.query.year}.zip"`).send(file);
    },
  );
};
