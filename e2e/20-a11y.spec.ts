import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers.ts';

const ROUTES = [
  '/', '/mitglieder', '/mitglieder/haushalte', '/mitglieder/dubletten', '/mitglieder/bestandserhebung', '/mitglieder/ehrungen', '/mitglieder/arbeitsstunden', '/gruppen', '/termine', '/versammlungen',
  '/beitraege', '/beitraege/laeufe', '/rechnungen', '/rechnungen/mahnwesen', '/rechnungen/artikel', '/bank', '/bank/abgleich', '/bank/lastschriften',
  '/buchhaltung', '/buchhaltung/euer', '/buchhaltung/haushaltsplan', '/buchhaltung/konten', '/buchhaltung/einstellungen', '/buchhaltung/export', '/buchhaltung/belege', '/buchhaltung/kassenbuch', '/buchhaltung/pauschalen',
  '/spenden', '/spenden/bestaetigungen', '/spenden/einstellungen', '/antraege', '/kommunikation', '/dokumente',
  '/einstellungen', '/einstellungen/email', '/einstellungen/aufnahme', '/einstellungen/import', '/einstellungen/datenschutz', '/einstellungen/export',
  '/einstellungen/felder', '/einstellungen/sicherheit', '/einstellungen/zugaenge', '/einstellungen/rollen', '/einstellungen/api', '/einstellungen/webhooks', '/einstellungen/protokoll',
];

/** Serious and critical WCAG 2.2 A/AA findings on the page as it is now. */
async function audit(page: Page, route: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${route} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

test('accessibility: no serious or critical axe findings on any admin route', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const found: string[] = [];
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main h1, main h2').first()).toBeVisible();
    found.push(...(await audit(page, route)));
  }
  expect(found).toEqual([]);
});

test('accessibility: sign-in page, portal sign-in and an open member sheet', async ({ page }) => {
  // Not signed in yet: the sign-in page first.
  await page.goto('/anmelden');
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
  const found = await audit(page, '/anmelden');
  await page.goto('/portal');
  await expect(page.getByRole('heading').first()).toBeVisible();
  found.push(...(await audit(page, '/portal')));
  await signIn(page);
  await page.goto('/mitglieder?neu=1');
  await expect(page.getByRole('dialog')).toBeVisible();
  found.push(...(await audit(page, 'member sheet')));
  expect(found).toEqual([]);
});

test('keyboard: skip link first, palette opens and closes from the keyboard', async ({ page }) => {
  await signIn(page);
  await page.goto('/mitglieder');
  await expect(page.getByRole('heading', { name: 'Mitglieder', level: 1 })).toBeVisible();
  // From the top of the document, as after a fresh page load.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Zum Inhalt springen' })).toBeInViewport();
  await expect(page.getByRole('link', { name: 'Zum Inhalt springen' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await page.keyboard.type('Gruppen');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/gruppen$/);
  await expect(palette).toBeHidden();
});
