import { lookup as lookupCb, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPrivateAddress } from '../webhooks/worker.ts';

/**
 * fetch for requests to addresses a club admin chose (OIDC issuer and everything its metadata names: token, keys,
 * user info). The private-network check happens in the connection's own DNS lookup, so the checked address is the
 * one connected to (no DNS rebinding); redirects are not followed. `allowPrivate` is for local development only.
 */
export function guardedFetch(allowPrivate: () => boolean) {
  const lookup: LookupFunction = (hostname, options, cb) => {
    lookupCb(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err, '', 4);
      const list = addrs as unknown as LookupAddress[];
      if (!allowPrivate() && (!list.length || list.some((a) => isPrivateAddress(a.address)))) return cb(new Error('Diese Adresse liegt in einem privaten Netz.'), '', 4);
      if (options.all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
  return (url: string, init: { method: string; headers: Record<string, string>; body?: unknown; signal?: AbortSignal }) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const body = init.body === undefined || init.body === null ? undefined : Buffer.from(String(init.body));
      // An IP literal skips the lookup, so it is checked here.
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (!allowPrivate() && /^[\d.]+$|:/.test(host) && isPrivateAddress(host)) return reject(new Error('Diese Adresse liegt in einem privaten Netz.'));
      const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(u, { method: init.method, headers: { ...init.headers, ...(body ? { 'content-length': String(body.length) } : {}) }, lookup, timeout: 10_000, signal: init.signal }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 1_000_000) req.destroy(new Error('Antwort zu groß.'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          const status = res.statusCode ?? 500;
          resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Keine Antwort innerhalb von 10 Sekunden.')));
      req.on('error', reject);
      req.end(body);
    });
}
