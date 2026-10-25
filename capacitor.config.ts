import type { CapacitorConfig } from '@capacitor/cli';

// The mobile apps wrap the same web build. They load it from the club's own OpenVerein server,
// so API, sign-in and permissions are exactly those of the web app (no separate native code path).
// Set OPENVEREIN_URL when building, e.g. https://verein.example.org (see docs/mobile.md).
const url = process.env.OPENVEREIN_URL;

const config: CapacitorConfig = {
  appId: process.env.OPENVEREIN_APP_ID ?? 'org.openverein.app',
  appName: process.env.OPENVEREIN_APP_NAME ?? 'OpenVerein',
  webDir: 'dist/web',
  server: url ? { url, cleartext: url.startsWith('http://') } : undefined,
  android: { allowMixedContent: false },
};

export default config;
