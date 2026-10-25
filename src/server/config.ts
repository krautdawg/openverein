const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3300),
  /** API requests per minute and client address (one office behind one address shares it) */
  rateLimitPerMinute: Math.max(Number(env.RATE_LIMIT_PER_MINUTE ?? 600) || 600, 60),
  databaseUrl: env.DATABASE_URL ?? 'postgres://openverein:openverein@localhost:54329/openverein',
  cookieSecure: env.COOKIE_SECURE === 'true',
  // Comma-separated proxy addresses/CIDRs whose X-Forwarded-For is trusted (e.g. "127.0.0.1,172.16.0.0/12").
  // Empty = trust no proxy, so clients cannot pick their own rate-limit key.
  trustProxy: (env.TRUST_PROXY ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  demoMode: env.DEMO_MODE === 'true',
  // Hours between demo resets; 0 = never. Capped at 24 days (setInterval's limit).
  demoResetHours: demoResetHours(env.DEMO_RESET_HOURS),
  // Public address of this installation, used in links inside e-mails.
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3300}`).replace(/\/$/, ''),
  // Uploaded files, stored by SHA-256 (content-addressed). Mount a volume here in production.
  filesDir: env.FILES_DIR ?? 'data/files',
  smtpUrl: env.SMTP_URL ?? 'smtp://localhost:11025',
  mailFrom: env.MAIL_FROM ?? 'OpenVerein <verein@example.org>',
  // shortcut: a fixed development key when DATA_KEY is unset outside production; set a real one for any club data.
  dataKey: env.DATA_KEY || (env.NODE_ENV === 'production' ? '' : 'b3BlbnZlcmVpbi1kZXZlbG9wbWVudC1rZXktbm90LXNlY3JldA=='),
  // Webhooks to private addresses or plain http: only for development and tests (SSRF guard).
  webhooksAllowPrivate: env.WEBHOOKS_ALLOW_PRIVATE === 'true',
  webDist: env.WEB_DIST ?? new URL('../../dist/web', import.meta.url).pathname,
  /** Managed hosting: several clubs, each under its own host name; clubs are created through the operator API. */
  multiTenant: env.MULTI_TENANT === 'true',
  /** Secret for the operator API (header X-Operator-Token), at least 32 characters; only used with MULTI_TENANT. */
  operatorToken: env.OPERATOR_TOKEN ?? '',
};
if (config.multiTenant && config.operatorToken.length < 32) throw new Error('MULTI_TENANT=true braucht OPERATOR_TOKEN mit mindestens 32 Zeichen.');
if (config.multiTenant && config.demoMode) throw new Error('DEMO_MODE und MULTI_TENANT schließen sich aus.');

/** Whole hours between demo resets, 0 to switch them off; anything else stops the start (a typo must not mean "never"). */
export function demoResetHours(v: string | undefined) {
  if (v === undefined || v === '') return 24;
  if (!/^\d+$/.test(v.trim()) || Number(v) > 24 * 24) throw new Error(`DEMO_RESET_HOURS muss eine ganze Zahl von 0 bis 576 sein, nicht „${v}“.`);
  return Number(v);
}
