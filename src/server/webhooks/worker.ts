import { createHmac } from 'node:crypto';
import { lookup as lookupCb, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { sql } from 'kysely';
import { config } from '../config.ts';
import { decrypt } from '../crypto.ts';
import type { Db } from '../db.ts';

const MAX_ATTEMPTS = 6;
/** Minutes until the next try after attempt n (1-based). */
const BACKOFF = [1, 5, 30, 120, 720];

/** Everything that is not a public unicast address: a webhook must not reach into the server's own network. */
const BLOCKED = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(net, bits, 'ipv4');
// IPv4-compatible (::/96), 6to4 (2002::/16) and Teredo (2001::/32) carry an IPv4 address too: blocked as a whole.
for (const [net, bits] of [['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(net, bits, 'ipv6');
/**
 * IPv4-mapped IPv6 in any spelling (::ffff:7f00:1, ::ffff:127.0.0.1) is checked against the IPv4 rules by BlockList
 * itself (Node 24); the test pins that.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(v);
  if (!kind) return true;
  return BLOCKED.check(v, kind === 4 ? 'ipv4' : 'ipv6');
}

/** Plain https only (unless explicitly allowed for development); an IP literal is checked right here. */
export function assertWebhookTarget(url: string) {
  const u = new URL(url);
  if (config.webhooksAllowPrivate) return;
  if (u.protocol !== 'https:') throw new Error('Webhooks gehen nur an https-Adressen.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new Error('Diese Adresse liegt in einem privaten Netz.');
}

/**
 * The address check happens in the connection's own DNS lookup: the address that was checked is the address the
 * socket connects to, so a name cannot answer with a public address for the check and a private one for the
 * connection (DNS rebinding). TLS still verifies the certificate against the host name.
 */
const pinnedLookup: LookupFunction = (hostname, options, cb) => {
  lookupCb(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '', 4);
    const list = addrs as unknown as LookupAddress[];
    if (!config.webhooksAllowPrivate && (!list.length || list.some((a) => isPrivateAddress(a.address)))) return cb(new Error('Diese Adresse liegt in einem privaten Netz.'), '', 4);
    if (options.all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
};

/** POST with the pinned lookup; no redirects are followed. Resolves with the status code. */
function post(url: string, headers: Record<string, string>, body: string) {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(u, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, lookup: pinnedLookup, timeout: 10_000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Keine Antwort innerhalb von 10 Sekunden.')));
    req.on('error', reject);
    req.end(body);
  });
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
        assertWebhookTarget(hook.url);
        const ts = Math.floor(Date.now() / 1000);
        status = await post(hook.url, { 'content-type': 'application/json', 'user-agent': 'OpenVerein-Webhook/1', 'x-openverein-event': d.event, 'x-openverein-delivery': d.id, 'x-openverein-timestamp': String(ts), 'x-openverein-signature': signature(decrypt(hook.secret_encrypted), ts, body) }, body);
        if (status < 200 || status >= 300) error = `Antwort ${status}`;
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

/** Delivered and failed webhook deliveries older than 30 days go; the receiver has had its chance. */
export async function pruneWebhookDeliveries(db: Db) {
  // Counted from the end of the delivery (sent, or the last failed attempt), not from the event: a delivery that was
  // late because the worker was down still stays 30 days for troubleshooting.
  const r = await db.deleteFrom('webhook_delivery').where('status', 'in', ['sent', 'failed']).where(sql<boolean>`coalesce(sent_at, claimed_at, occurred_at) < now() - interval '30 days'`).executeTakeFirst();
  return Number(r.numDeletedRows);
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
