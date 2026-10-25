import { defineConfig, devices } from '@playwright/test';

const port = 3399;
const dbUrl = process.env.E2E_DATABASE_URL ?? 'postgres://openverein:openverein@localhost:54329/openverein_e2e';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } },
  ],
  webServer: {
    command: 'node e2e/reset-db.ts && npm run build && node src/server/index.ts',
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(port), DATABASE_URL: dbUrl, E2E_DATABASE_URL: dbUrl, SMTP_URL: 'smtp://localhost:11025', RATE_LIMIT_PER_MINUTE: '100000', WEBHOOKS_ALLOW_PRIVATE: 'true' },
  },
});
