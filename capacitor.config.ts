import type { CapacitorConfig } from '@capacitor/cli';

// The mobile apps wrap the same web build. They load it from the club's own OpenVerein server,
// so API, sign-in and permissions are exactly those of the web app (no separate native code path).
// Set OPENVEREIN_URL when building, e.g. https://verein.example.org (see docs/mobile.md).
const url = process.env.OPENVEREIN_URL;
// Passwords and member data must never travel unencrypted: http only for an explicit local development build.
const devHttp = process.env.OPENVEREIN_DEV_HTTP === 'true' && !!url && /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?(\/|$)/.test(url);
if (url && !url.startsWith('https://') && !devHttp) {
  throw new Error(`OPENVEREIN_URL muss mit https:// beginnen (${url}). Nur für die lokale Entwicklung: OPENVEREIN_DEV_HTTP=true mit localhost oder 10.0.2.2.`);
}

const config: CapacitorConfig = {
  appId: process.env.OPENVEREIN_APP_ID ?? 'org.openverein.app',
  appName: process.env.OPENVEREIN_APP_NAME ?? 'OpenVerein',
  webDir: 'dist/web',
  server: url ? { url, cleartext: devHttp } : undefined,
  android: { allowMixedContent: false },
};

export default config;
