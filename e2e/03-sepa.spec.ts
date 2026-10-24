import { expect, test } from '@playwright/test';
import { addBusinessDays } from '../src/server/sepa/pain.ts';
import { signIn } from './helpers.ts';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

test('SEPA: mandate, direct debit file, statement import settles the invoice', async ({ page }) => {
  await signIn(page);
  await page.request.patch('/api/v1/organization', { data: { creditorId: 'DE98ZZZ09999999999', iban: 'DE89370400440532013000' } });
  await page.request.post('/api/v1/bank-accounts', { data: { name: 'Vereinskonto', iban: 'DE89370400440532013000', openingDate: '2026-01-01' } });
  const m = await (await page.request.post('/api/v1/members', { data: { firstName: 'Lara', lastName: 'Lastschrift', joinDate: '2024-01-01' } })).json();
  await page.request.patch(`/api/v1/members/${m.id}/payment-method`, { data: { paymentMethod: 'direct_debit' } });

  await page.goto(`/mitglieder/${m.id}`);
  const sheet = page.getByRole('dialog', { name: 'Lastschrift, Lara' });
  await sheet.getByRole('button', { name: 'Mandat erfassen' }).click();
  await sheet.getByLabel('IBAN').fill('DE02 1203 0000 0000 2020 51');
  await sheet.getByRole('button', { name: 'Speichern' }).click();
  await expect(sheet.getByText('Mandatsreferenz')).toBeVisible();

  const draft = await (await page.request.post('/api/v1/invoices', { data: { memberId: m.id, dueDate: today(), lines: [{ text: 'Beitrag', unitCents: 4200 }] } })).json();
  await page.request.post(`/api/v1/invoices/${draft.id}/issue`, { data: {} });

  await page.goto('/bank/lastschriften');
  const date = addBusinessDays(today(), 3);
  await page.getByLabel('Einzugsdatum').fill(date);
  await page.getByRole('button', { name: /Lastschriftdatei für 1 Posten/ }).click();
  await expect(page.getByRole('heading', { name: /Lastschrifteinzug zum/ })).toBeVisible();
  const e2e = (await page.getByRole('table', { name: 'Posten' }).locator('td.meta').first().textContent())!.trim();

  const camt = `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>
<Ntry><Amt Ccy="EUR">42.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${date}</Dt></BookgDt><NtryDtls><TxDtls><Refs><EndToEndId>${e2e}</EndToEndId></Refs><RltdPties><Dbtr><Pty><Nm>Lara Lastschrift</Nm></Pty></Dbtr></RltdPties><RmtInf><Ustrd>Lastschrift</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
  await page.goto('/bank');
  await page.getByRole('button', { name: 'Auszug einlesen' }).click();
  await page.getByLabel('Kontoauszug auswählen').setInputFiles({ name: 'auszug.xml', mimeType: 'application/xml', buffer: Buffer.from(camt) });
  await expect(page.getByRole('status')).toContainText('1 automatisch zugeordnet');

  await page.goto(`/rechnungen/${draft.id}`);
  await expect(page.getByRole('dialog').getByText('Bezahlt')).toBeVisible();
});
