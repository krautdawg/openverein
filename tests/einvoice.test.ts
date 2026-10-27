import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp } from './helpers.ts';
import { processQueue } from '../src/server/mail/worker.ts';
import { vatGroup } from '../src/server/invoices/xrechnung.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';
const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
});

describe('e-invoices', () => {
  it('keeps net lines, basis and tax consistent with the gross total', () => {
    const g = vatGroup([{ grossCents: 11900 }, { grossCents: 1001 }], 19);
    expect(g.nets.reduce((s, n) => s + n, 0)).toBe(g.basis);
    expect(g.tax).toBe(Math.round((g.basis * 19) / 100));
    expect(Math.abs(g.gross - g.basis - g.tax)).toBeLessThanOrEqual(1);
  });

  it('refuses to issue while XRechnung fields are missing, then issues with a stored XML', async () => {
    const m = (await admin.post('/members', { kind: 'organisation', companyName: 'Stadt Lindenhof', street: 'Rathausplatz 1', postalCode: '12345', city: 'Lindenhof', joinDate: '2024-01-01', einvoiceFormat: 'xrechnung' })).body;
    expect(m.einvoice.format).toBe('xrechnung');
    const draft = (await admin.post('/invoices', { memberId: m.id, coverText: 'Rechnung für {{name}}', lines: [{ text: 'Hallennutzung', unitCents: 11900, taxRate: 19 }] })).body;
    const refused = await admin.post(`/invoices/${draft.id}/issue`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.missing.join(' ')).toMatch(/Leitweg-ID.*E-Rechnungsadresse|E-Rechnungsadresse/);
    expect(refused.body.missing.join(' ')).toContain('USt-IdNr.');

    await admin.patch('/organization', { street: 'Am Sportplatz 1', postalCode: '12345', city: 'Lindenhof', email: 'kasse@example.org', iban: 'DE89370400440532013000', vatId: 'DE123456789', einvoiceContactName: 'Erika Mustermann', einvoiceContactPhone: '+49 30 1234567' });
    await admin.patch(`/members/${m.id}`, { buyerReference: '04011000-12345-67', einvoiceAddress: 'rechnung@lindenhof.example' });
    const issued = await admin.post(`/invoices/${draft.id}/issue`, {});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const xml = await ctx.app.inject({ url: `/api/v1/invoices/${draft.id}/xrechnung.xml`, headers: { cookie } });
    expect(xml.statusCode).toBe(200);
    expect(xml.body).toContain('<ram:BuyerReference>04011000-12345-67</ram:BuyerReference>');
    expect(xml.body).toContain('<ram:DuePayableAmount>119.00</ram:DuePayableAmount>');
    // The XML carries the cover text as filled for the PDF, not the template.
    expect(xml.body).toContain('Rechnung für Stadt Lindenhof');
    expect(xml.body).not.toContain('{{name}}');
    await expect(ctx.db.updateTable('invoice_einvoice').set({ sha256: 'x' }).execute()).rejects.toThrow();

    // Mailed to the e-invoice address (the city has no ordinary e-mail here), with PDF and XML attached.
    const sent = await admin.post('/invoices/send-mail', { invoiceIds: [draft.id] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.toPrint).toEqual([]);
    await processQueue(ctx.db);
    const found = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:rechnung@lindenhof.example')}`)).json()).messages as { ID: string; Attachments: number }[];
    expect(found[0]!.Attachments).toBe(2);
    const msg = await (await fetch(`${MAILPIT}/api/v1/message/${found[0]!.ID}`)).json() as { Attachments: { FileName: string }[] };
    expect(msg.Attachments.map((x) => x.FileName).sort()).toEqual([`${issued.body.number}.pdf`, `${issued.body.number}.xml`]);
  });
});
