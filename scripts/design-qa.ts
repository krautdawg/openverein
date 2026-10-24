// Screenshots pages at 390 / 768 / 1280 for design QA.
// Usage: node scripts/design-qa.ts <baseUrl> <outDir> <path>[,<path>...]
// Signs in as the e2e admin (creates the club first if needed).
import { chromium } from '@playwright/test';

const [base = 'http://localhost:3399', out = 'design-qa', list = '/'] = process.argv.slice(2);
const creds = { email: 'erika@example.org', password: 'korrekt-pferd-batterie' };
const browser = await chromium.launch({ channel: 'chrome' });

for (const width of [390, 768, 1280]) {
  const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'de-DE' });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.waitForLoadState('networkidle');
  for (const path of list.split(',')) {
    if (path === '/anmelden' || path === '/setup') {
      await ctx.clearCookies();
    } else if (!(await ctx.cookies()).some((c) => c.name === 'ov_session')) {
      const setup = await page.request.get(base + '/api/v1/setup');
      if ((await setup.json()).needsSetup) {
        await page.request.post(base + '/api/v1/setup', { data: { clubName: 'TSV Musterstadt 1890 e.V.', name: 'Erika Mustermann', ...creds } });
      } else {
        await page.request.post(base + '/api/v1/auth/login', { data: creds });
      }
    }
    await page.goto(base + (path === '/setup' ? '/' : path));
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(250);
    const name = `${out}/${width}-${path.replace(/\W+/g, '_') || 'root'}.png`;
    await page.screenshot({ path: name, fullPage: true });
    console.log(name);
  }
  await ctx.close();
}
await browser.close();
