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

describe('custom fields', () => {
  it('validates values, filters and exports them, fills mail placeholders, and locks the type once used', async () => {
    const size = (await admin.post('/custom-fields', { key: 'trikot', label: 'Trikotgröße', type: 'select', options: ['S', 'M', 'L'], required: true })).body;
    expect(size.id).toBeTruthy();
    expect((await admin.post('/members', { lastName: 'Ohne', joinDate: '2024-01-01' })).status).toBe(400);
    const m = await admin.post('/members', { lastName: 'Mit', firstName: 'Mia', joinDate: '2024-01-01', custom: { [size.id]: 'M' } });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    expect(m.body.custom).toEqual({ [size.id]: 'M' });
    expect((await admin.patch(`/members/${m.body.id}`, { custom: { [size.id]: 'XXL' } })).status).toBe(400);
    expect((await admin.patch(`/members/${m.body.id}`, { custom: { [size.id]: 'L' } })).body.custom[size.id]).toBe('L');

    expect((await admin.get(`/members?cf=${size.id}:L`)).body.total).toBe(1);
    expect((await admin.get(`/members?cf=${size.id}:S`)).body.total).toBe(0);
    const csv = await ctx.app.inject({ url: '/api/v1/members/export.csv', headers: { cookie } });
    expect(csv.body.split('\r\n')[0]).toContain('Trikotgröße');
    expect(csv.body).toContain(';L');
    const preview = await admin.post('/messages/preview', { subject: 'Hallo', body: 'Größe {{custom.trikot}}', memberId: m.body.id });
    expect(preview.body.body).toBe('Größe L');

    expect((await admin.patch(`/custom-fields/${size.id}`, { type: 'text' })).status).toBe(409);
    expect((await admin.patch(`/custom-fields/${size.id}`, { options: ['S', 'M'] })).body.type).toContain('option-in-use');
    expect((await admin.del(`/custom-fields/${size.id}`)).status).toBe(409);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/custom-fields/${size.id}`, headers: { cookie }, payload: { confirm: 'Trikotgröße' } })).statusCode).toBe(204);
    expect((await admin.get(`/members/${m.body.id}`)).body.custom).toEqual({});
  });

  it('hides sensitive fields from group-scoped users', async () => {
    const health = (await admin.post('/custom-fields', { key: 'allergien', label: 'Allergien', type: 'text', sensitive: true })).body;
    const group = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const m = (await admin.post('/members', { lastName: 'Sens', joinDate: '2024-01-01', groupIds: [group], custom: { [health.id]: 'Nüsse' } })).body;
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Trainer:in', [group]) });
    expect((await trainer.get('/custom-fields')).body).toEqual([]);
    expect((await trainer.get(`/members/${m.id}`)).body.custom).toEqual({});
    expect((await trainer.patch(`/members/${m.id}`, { custom: { [health.id]: 'keine' } })).status).toBeGreaterThanOrEqual(400);
    await admin.patch(`/members/${m.id}`, { custom: { [health.id]: 'Pollen' } });
    const log = await ctx.db.selectFrom('audit_event').select('diff').where('action', '=', 'person.custom_updated').execute();
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toMatch(/Nüsse|Pollen/);
  });

  it('skips unchanged values, masks history of fields made sensitive, and is covered by export and anonymisation', async () => {
    const size = (await admin.post('/custom-fields', { key: 'groesse', label: 'Größe', type: 'text' })).body;
    const flag = (await admin.post('/custom-fields', { key: 'ehrenamt', label: 'Ehrenamt', type: 'checkbox' })).body;
    const group = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const m = (await admin.post('/members', { lastName: 'Hist', joinDate: '2015-01-01', groupIds: [group], custom: { [size.id]: '180' } })).body;
    await admin.patch(`/members/${m.id}`, { custom: { [size.id]: '181' } });
    await admin.patch(`/members/${m.id}`, { custom: { [size.id]: '181', [flag.id]: false } }); // nothing changed
    const audits = await ctx.db.selectFrom('audit_event').select('id').where('action', '=', 'person.custom_updated').execute();
    expect(audits).toHaveLength(1);
    // A required field added later does not block saving other values.
    const req = (await admin.post('/custom-fields', { key: 'pflicht', label: 'Pflicht', type: 'text', required: true })).body;
    expect((await admin.patch(`/members/${m.id}`, { custom: { [size.id]: '182', [req.id]: null } })).status).toBe(200);

    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Trainer:in', [group]) });
    const seen = (await trainer.get(`/members/${m.id}`)).body.timeline.map((t: { diff: unknown }) => JSON.stringify(t.diff)).join();
    expect(seen).toContain('181');
    await admin.patch(`/custom-fields/${size.id}`, { sensitive: true });
    const masked = (await trainer.get(`/members/${m.id}`)).body.timeline.map((t: { diff: unknown }) => JSON.stringify(t.diff)).join();
    expect(masked).not.toContain('181');

    const res = await ctx.app.inject({ url: `/api/v1/persons/${m.personId}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await admin.post(`/members/${m.id}/resign`, { noticeDate: '2020-09-01', exitDate: '2020-12-31' });
    expect((await admin.post(`/persons/${m.personId}/anonymise`, {})).status).toBe(200);
    expect((await ctx.db.selectFrom('person').select('custom').where('id', '=', m.personId).executeTakeFirstOrThrow()).custom).toEqual({});
  });
});
