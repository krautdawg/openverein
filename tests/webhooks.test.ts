import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { encrypt } from '../src/server/crypto.ts';
import { isPrivateAddress, processWebhooks, pruneWebhookDeliveries, signature } from '../src/server/webhooks/worker.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let cookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  cookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie });
});

describe('webhooks', () => {
  it('refuses private and plain-http targets in production mode', async () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    for (const ip of ['::1', 'fd00::1', 'fe80::1', '2001:db8::1', 'ff02::1', '224.0.0.1', '198.51.100.7', '[::1]']) expect(isPrivateAddress(ip), ip).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('[2606:4700:4700::1111]')).toBe(false);
    config.webhooksAllowPrivate = false;
    expect((await admin.post('/webhooks', { url: 'http://example.org/hook', topics: ['member'] })).status).toBe(400);
    expect((await admin.post('/webhooks', { url: 'https://127.0.0.1/hook', topics: ['member'] })).status).toBe(400);
    expect((await admin.post('/webhooks', { url: 'https://[::1]/hook', topics: ['member'] })).status).toBe(400);
    expect((await admin.post('/webhooks', { url: 'https://localhost/hook', topics: ['member'] })).status).toBe(400);
    // A public IPv6 literal is a valid target.
    expect((await admin.post('/webhooks', { url: 'https://[2606:4700:4700::1111]/hook', topics: ['member'] })).status).toBe(201);
  });

  it('checks the address at connection time, so a name that turns private is not reached', async () => {
    config.webhooksAllowPrivate = false;
    // Stored directly: a name that passed the check at registration and resolves to loopback now (DNS rebinding).
    const org = (await ctx.db.selectFrom('organization').select('id').executeTakeFirstOrThrow()).id;
    const hook = await ctx.db.insertInto('webhook').values({ organization_id: org, url: 'https://localhost:1/hook', topics: ['member'], secret_encrypted: encrypt('s'.repeat(32)), active: true }).returning('id').executeTakeFirstOrThrow();
    await ctx.db.insertInto('webhook_delivery').values({ webhook_id: hook.id, organization_id: org, event: 'member.updated', entity_type: 'member', entity_id: null, occurred_at: new Date() }).execute();
    await processWebhooks(ctx.db);
    const d = await ctx.db.selectFrom('webhook_delivery').select(['error', 'status']).executeTakeFirstOrThrow();
    expect(d.error).toContain('privaten Netz');
  });

  it('queues subscribed changes in the same transaction, signs them, retries failures, and is admin-only', async () => {
    config.webhooksAllowPrivate = true;
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    let fail = true;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(fail ? 500 : 204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      const created = await admin.post('/webhooks', { url, topics: ['member'] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const secret = created.body.secret as string;
      await admin.post('/members', { lastName: 'Hook', joinDate: '2024-01-01' });
      await admin.post('/groups', { name: 'Nicht abonniert', shortCode: 'NA' });

      expect(await processWebhooks(ctx.db)).toBe(1);
      let d = (await admin.get(`/webhooks/${created.body.webhook.id}/deliveries`)).body[0];
      expect(d).toMatchObject({ event: 'member.created', status: 'queued', attempts: 1, responseStatus: 500 });

      fail = false;
      await ctx.db.updateTable('webhook_delivery').set({ next_attempt_at: new Date() }).execute();
      expect(await processWebhooks(ctx.db)).toBe(1);
      d = (await admin.get(`/webhooks/${created.body.webhook.id}/deliveries`)).body[0];
      expect(d).toMatchObject({ status: 'sent', attempts: 2 });

      const last = received.at(-1)!;
      const payload = JSON.parse(last.body);
      expect(payload).toMatchObject({ event: 'member.created', entityType: 'member' });
      expect(payload).not.toHaveProperty('diff');
      expect(last.headers['x-openverein-signature']).toBe(signature(secret, Number(last.headers['x-openverein-timestamp']), last.body));

      // Old delivered entries are pruned, fresh ones kept.
      await ctx.db.updateTable('webhook_delivery').set({ occurred_at: new Date(Date.now() - 31 * 86_400_000) }).where('status', '=', 'sent').execute();
      expect(await pruneWebhookDeliveries(ctx.db)).toBe(1);

      const treasurer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Kassenwart', null) });
      expect((await treasurer.get('/webhooks')).status).toBe(403);
    } finally {
      server.close();
    }
  });
});
