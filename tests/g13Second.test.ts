import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, decryptBytes, encrypt } from '../src/server/crypto.ts';
import { addBusinessDays } from '../src/server/sepa/pain.ts';
import { client, reset, setupClub, testApp } from './helpers.ts';

/** Findings of the second (Codex) review of group G13 (#62-#68). Each test failed on the code before the fix. */
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
  await admin.patch('/organization', { street: 'Am Sportplatz 1', postalCode: '12345', city: 'Lindenhof', email: 'kasse@example.org', iban: 'DE89370400440532013000', vatId: 'DE123456789', einvoiceContactName: 'Erika Mustermann', einvoiceContactPhone: '+49 30 1234567' });
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const member = async (extra: Record<string, unknown> = {}) => (await admin.post('/members', { lastName: 'Kunde', firstName: 'Karl', street: 'Weg 1', postalCode: '12345', city: 'Lindenhof', joinDate: '2020-01-01', ...extra })).body as { id: string; personId: string };

describe('G13 second review', () => {
  it('refuses a net price whose rounded gross unit would change the line total', async () => {
    const m = await member();
    const r = await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Schrauben', quantity: 100, unitCents: 1, taxRate: 19, net: true }] });
    expect(r.status).toBe(400);
    // Without drift (1 × 100 € net) the net entry stays possible.
    expect((await admin.post('/invoices', { memberId: m.id, lines: [{ text: 'Miete', quantity: 1, unitCents: 10000, taxRate: 19, net: true }] })).status).toBe(201);
  });

  it('gives a credit note no "please pay" default text', async () => {
    await admin.patch('/organization', { invoiceClosingTemplate: 'Bitte zahle {{betrag}} bis {{faellig}}.' });
    const m = await member();
    const credit = (await admin.post('/invoices', { memberId: m.id, kind: 'credit_note', lines: [{ text: 'Erstattung', unitCents: 1200 }] })).body;
    await admin.post(`/invoices/${credit.id}/issue`, {});
    expect((await admin.get(`/invoices/${credit.id}`)).body.closingText).toBeNull();
  });

  it('puts the closing text into the XRechnung as well', async () => {
    const m = await member({ kind: 'organisation', companyName: 'Stadt Lindenhof', einvoiceFormat: 'xrechnung' });
    await admin.patch(`/members/${m.id}`, { buyerReference: '04011000-12345-67', einvoiceAddress: 'rechnung@lindenhof.example' });
    const inv = (await admin.post('/invoices', { memberId: m.id, closingText: 'Zahlbar ohne Abzug innerhalb von 14 Tagen.', lines: [{ text: 'Hallennutzung', unitCents: 11900, taxRate: 19 }] })).body;
    expect((await admin.post(`/invoices/${inv.id}/issue`, {})).status).toBe(200);
    const xml = await ctx.app.inject({ url: `/api/v1/invoices/${inv.id}/xrechnung.xml`, headers: { cookie } });
    expect(xml.body).toContain('Zahlbar ohne Abzug innerhalb von 14 Tagen.');
  });

  it('queues the expense decision mail with the decision, so a failed send is retried', async () => {
    const m = await member({ email: 'karl@example.org' });
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    const file = await ctx.db.insertInto('file').values({ organization_id: org, folder_id: null, member_id: null, purpose: 'receipt', sha256: 'b'.repeat(64), size_bytes: 1, mime_type: 'application/pdf', name: 'beleg.pdf', retention_class: 'voucher', retain_until: '2035-12-31', uploaded_by: null }).returning('id').executeTakeFirstOrThrow();
    const claim = await ctx.db.insertInto('expense_claim').values({ organization_id: org, member_id: m.id, person_id: m.personId, purpose: 'Bälle', spent_on: '2026-03-01', amount_cents: 1000, account_holder: 'Karl', iban_encrypted: encrypt('DE02120300000000202051'), file_id: file.id }).returning('id').executeTakeFirstOrThrow();
    const rej = await admin.post(`/expense-claims/${claim.id}/reject`, { reason: 'Kein Vereinszweck' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    const d = await ctx.db.selectFrom('delivery').select(['email', 'status']).where('person_id', '=', m.personId).execute();
    expect(d).toEqual([{ email: 'karl@example.org', status: 'queued' }]);
  });

  it('keeps the invoice number in a SEPA remittance that the template made too long', async () => {
    const long = 'Turn- und Sportgemeinschaft Lindenhof-Musterstadt von 1890 eingetragener Verein Abteilung Tennis und Badminton';
    await admin.patch('/organization', { name: long, creditorId: 'DE98ZZZ09999999999', prenotificationDays: 1, remittanceTemplate: '{{verein}} {{verein}} {{rechnungsnummer}}' });
    const accountId = (await admin.post('/bank-accounts', { name: 'Vereinskonto', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', openingDate: '2026-01-01', openingBalanceCents: 0 })).body.id;
    const m = await member();
    await admin.patch(`/members/${m.id}/payment-method`, { paymentMethod: 'direct_debit' });
    await admin.post(`/members/${m.id}/mandates`, { signedOn: '2024-01-15', accountHolder: 'Karl Kunde', iban: 'DE02120300000000202051' });
    const inv = (await admin.post('/invoices', { memberId: m.id, dueDate: today(), lines: [{ text: 'Beitrag', unitCents: 5000 }] })).body;
    await admin.post(`/invoices/${inv.id}/issue`, {});
    const number = (await admin.get(`/invoices/${inv.id}`)).body.number as string;
    const run = await admin.post('/collection-runs', { bankAccountId: accountId, collectionDate: addBusinessDays(today(), 3), invoiceIds: [inv.id] });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const f = await ctx.db.selectFrom('collection_file').select('xml_encrypted').executeTakeFirstOrThrow();
    const xml = (() => {
      try {
        return decrypt(f.xml_encrypted);
      } catch {
        return decryptBytes(Buffer.from(f.xml_encrypted, 'base64')).toString();
      }
    })();
    expect(/<Ustrd>([^<]*)<\/Ustrd>/.exec(xml)![1]).toContain(number);
  });
});
