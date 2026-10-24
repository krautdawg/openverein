const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3300),
  databaseUrl: env.DATABASE_URL ?? 'postgres://openverein:openverein@localhost:54329/openverein',
  cookieSecure: env.COOKIE_SECURE === 'true',
  // Comma-separated proxy addresses/CIDRs whose X-Forwarded-For is trusted (e.g. "127.0.0.1,172.16.0.0/12").
  // Empty = trust no proxy, so clients cannot pick their own rate-limit key.
  trustProxy: (env.TRUST_PROXY ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  demoMode: env.DEMO_MODE === 'true',
  smtpUrl: env.SMTP_URL ?? 'smtp://localhost:11025',
  mailFrom: env.MAIL_FROM ?? 'OpenVerein <verein@example.org>',
  webDist: env.WEB_DIST ?? new URL('../../dist/web', import.meta.url).pathname,
};
