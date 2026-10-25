import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('articles', () => {
  it('keeps a catalogue with unique active names, archives instead of deleting, and is read-only for readers', async () => {
    const a = await admin.post('/articles', { name: 'Vereinstrikot', unitCents: 3500, taxRate: 19 });
    expect(a.status).toBe(201);
    expect((await admin.post('/articles', { name: 'vereinstrikot', unitCents: 1 })).status).toBe(409);
    expect((await admin.put(`/articles/${a.body.id}`, { name: 'Vereinstrikot', unitCents: 3900, taxRate: 19, archived: true })).body).toMatchObject({ unitCents: 3900, archived: true });
    expect((await admin.get('/articles')).body).toEqual([]);
    expect((await admin.get('/articles?includeArchived=true')).body).toHaveLength(1);
    // The name is free again once archived.
    expect((await admin.post('/articles', { name: 'Vereinstrikot', unitCents: 3900, taxRate: 19 })).status).toBe(201);
    const auditor = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Kassenprüfung', null) });
    expect((await auditor.get('/articles')).status).toBe(200);
    expect((await auditor.post('/articles', { name: 'X', unitCents: 1 })).status).toBe(403);
  });
});
