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

const names = (r: { body: { items: { lastName: string }[] } }) => r.body.items.map((i) => i.lastName).sort();

describe('member facets and saved views', () => {
  it('filters by age, join date, payment method, open balance and exit range', async () => {
    const thisYear = new Date().getFullYear();
    await admin.post('/members', { lastName: 'Kind', birthDate: `${thisYear - 10}-01-01`, joinDate: '2024-03-01' });
    const adult = (await admin.post('/members', { lastName: 'Erwachsen', birthDate: `${thisYear - 40}-01-01`, joinDate: '2015-01-01' })).body;
    const gone = (await admin.post('/members', { lastName: 'Weg', joinDate: '2010-01-01' })).body;
    await admin.post(`/members/${gone.id}/resign`, { noticeDate: '2022-09-01', exitDate: '2022-12-31' });
    await admin.patch(`/members/${adult.id}/payment-method`, { paymentMethod: 'transfer' });
    const inv = (await admin.post('/invoices', { memberId: adult.id, lines: [{ text: 'Beitrag', unitCents: 1000 }] })).body;
    await admin.post(`/invoices/${inv.id}/issue`, {});

    expect(names(await admin.get('/members?ageTo=17'))).toEqual(['Kind']);
    expect(names(await admin.get('/members?ageFrom=18'))).toEqual(['Erwachsen']);
    expect(names(await admin.get('/members?joinFrom=2024-01-01'))).toEqual(['Kind']);
    expect(names(await admin.get('/members?paymentMethod=transfer'))).toEqual(['Erwachsen']);
    expect(names(await admin.get('/members?openBalance=true'))).toEqual(['Erwachsen']);
    expect(names(await admin.get('/members?exitFrom=2022-01-01&exitTo=2022-12-31&includeFormer=true'))).toEqual(['Weg']);
    expect(names(await admin.get('/members?mandate=none&household=no&ageTo=17'))).toEqual(['Kind']);
  });

  it('saves private views, shares them with a role only with settings rights', async () => {
    const mine = await admin.post('/member-views', { name: 'Jugend', params: 'alter_bis=17&gruppe=x' });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    const roles = (await admin.get('/roles')).body as { id: string; name: string }[];
    const trainerRole = roles.find((r) => r.name === 'Trainer:in')!;
    const shared = await admin.post('/member-views', { name: 'Für Trainer', params: 'offen=true', sharedRoleId: trainerRole.id });
    expect(shared.body.shared).toBe(true);
    const group = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Trainer:in', [group]) });
    expect((await trainer.get('/member-views')).body.map((v: { name: string }) => v.name)).toEqual(['Für Trainer']);
    expect((await trainer.post('/member-views', { name: 'X', params: '', sharedRoleId: trainerRole.id })).status).toBe(403);
    expect((await trainer.del(`/member-views/${shared.body.id}`)).status).toBe(403);
    expect((await admin.del(`/member-views/${mine.body.id}`)).status).toBe(204);
  });
});
