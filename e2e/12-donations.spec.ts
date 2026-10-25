import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('donations: exemption data, record a donation from a non-member, issue a receipt', async ({ page }) => {
  await signIn(page);
  await page.goto('/spenden/einstellungen');
  await page.getByLabel('Finanzamt').fill('Musterstadt');
  await page.getByLabel('Steuernummer').fill('12/345/67890');
  await page.getByLabel('Datum des Bescheids').fill('2025-05-01');
  await page.getByLabel('Veranlagungszeitraum').fill('2021–2023');
  await page.getByLabel('Begünstigte Zwecke (wie im Bescheid)').fill('des Sports (§ 52 Abs. 2 Satz 1 Nr. 21 AO)');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('status')).toHaveText('Gespeichert.');

  await page.getByRole('link', { name: 'Spenden', exact: true }).first().click();
  await page.getByRole('button', { name: 'Spende erfassen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Spende erfassen' });
  await sheet.getByRole('button', { name: /Kein Mitglied/ }).click();
  await sheet.getByLabel('Vorname').fill('Bernd');
  await sheet.getByLabel('Nachname').fill('Krause');
  await sheet.getByLabel('Straße und Hausnummer').fill('Bäckerweg 3');
  await sheet.getByLabel('PLZ').fill('12345');
  await sheet.getByLabel('Ort').fill('Musterstadt');
  await sheet.getByLabel('Betrag').fill('250,00');
  await sheet.getByLabel('Eingegangen auf').selectOption({ label: '1100 Bank' });
  await sheet.getByRole('button', { name: 'Erfassen' }).click();
  const row = page.getByRole('row', { name: /Bernd Krause/ });
  await expect(row).toContainText('250,00');
  await row.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(row.getByRole('link', { name: /^ZB-\d{4}-0001$/ })).toBeVisible();
});
