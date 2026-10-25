import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { isPrivateAddress, processWebhooks, signature } from '../src/server/webhooks/worker.ts';
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
    config.webhooksAllowPrivate = false;
    expect((await admin.post('/webhooks', { url: 'http://example.org/hook', topics: ['member'] })).status).toBe(400);
    expect((await admin.post('/webhooks', { url: 'https://127.0.0.1/hook', topics: ['member'] })).status).toBe(400);
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

      const treasurer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Kassenwart', null) });
      expect((await treasurer.get('/webhooks')).status).toBe(403);
    } finally {
      server.close();
    }
  });
});
