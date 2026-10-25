import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sql } from 'kysely';
import { config } from '../config.ts';
import { decrypt } from '../crypto.ts';
import type { Db } from '../db.ts';

const MAX_ATTEMPTS = 6;
/** Minutes until the next try after attempt n (1-based). */
const BACKOFF = [1, 5, 30, 120, 720];

/** Private, loopback, link-local and unspecified addresses: a webhook must not reach into the server's own network. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || (v6.startsWith('::ffff:') && isPrivateAddress(v6.slice(7)));
}

/** Refuses plain http and private targets unless explicitly allowed (development). */
export async function assertWebhookTarget(url: string) {
  const u = new URL(url);
  if (config.webhooksAllowPrivate) return;
  if (u.protocol !== 'https:') throw new Error('Webhooks gehen nur an https-Adressen.');
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('Diese Adresse liegt in einem privaten Netz.');
}

export const signature = (secret: string, timestamp: number, body: string) => 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/** Sends due deliveries one by one; a claim older than 10 minutes counts as crashed and is retried. */
export async function processWebhooks(db: Db) {
  let n = 0;
  for (;;) {
    const d = await sql<{ id: string; webhook_id: string; event: string; entity_type: string; entity_id: string | null; occurred_at: Date; attempts: number }>`
      update webhook_delivery set status = 'sending', claimed_at = now(), attempts = attempts + 1
      where id = (
        select id from webhook_delivery
        where (status = 'queued' and next_attempt_at <= now()) or (status = 'sending' and claimed_at < now() - interval '10 minutes')
        order by next_attempt_at for update skip locked limit 1)
      returning id, webhook_id, event, entity_type, entity_id, occurred_at, attempts`.execute(db).then((r) => r.rows[0]);
    if (!d) return n;
    n++;
    const hook = await db.selectFrom('webhook').select(['url', 'secret_encrypted', 'active']).where('id', '=', d.webhook_id).executeTakeFirst();
    const body = JSON.stringify({ id: d.id, event: d.event, entityType: d.entity_type, entityId: d.entity_id, occurredAt: d.occurred_at.toISOString() });
    let status: number | null = null;
    let error: string | null = null;
    if (!hook || !hook.active) error = 'Webhook ist deaktiviert.';
    else {
      try {
        await assertWebhookTarget(hook.url);
        const ts = Math.floor(Date.now() / 1000);
        const res = await fetch(hook.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', 'user-agent': 'OpenVerein-Webhook/1', 'x-openverein-event': d.event, 'x-openverein-delivery': d.id, 'x-openverein-timestamp': String(ts), 'x-openverein-signature': signature(decrypt(hook.secret_encrypted), ts, body) },
          body,
        });
        status = res.status;
        if (res.status < 200 || res.status >= 300) error = `Antwort ${res.status}`;
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
      }
    }
    if (!error) {
      await db.updateTable('webhook_delivery').set({ status: 'sent', sent_at: new Date(), response_status: status, error: null }).where('id', '=', d.id).execute();
    } else {
      const last = d.attempts >= MAX_ATTEMPTS || !hook?.active;
      await db.updateTable('webhook_delivery').set({ status: last ? 'failed' : 'queued', response_status: status, error, next_attempt_at: sql<Date>`now() + make_interval(mins => ${BACKOFF[Math.min(d.attempts, BACKOFF.length) - 1]!})` }).where('id', '=', d.id).execute();
    }
  }
}

export function startWebhookWorker(db: Db, log: (err: unknown) => void) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processWebhooks(db);
    } catch (err) {
      log(err);
    } finally {
      running = false;
    }
  };
  return setInterval(() => void tick(), 5_000).unref();
}
