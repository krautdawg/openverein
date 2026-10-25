import { randomUUID } from 'node:crypto';

/** Public credentials of the demo club (shown on the demo's sign-in page). */
export const DEMO_LOGIN = { email: 'demo@openverein.example', password: 'verein-demo-2026' };

/** Per-process secret: only the demo seed may run setup on a demo instance (and its club is marked as demo). */
export const DEMO_SEED_KEY = randomUUID();
