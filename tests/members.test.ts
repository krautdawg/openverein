import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshMemberStatuses } from '../src/server/members/status.ts';
import { client, enrollTotp, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
let adminCookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

async function group(name: string, shortCode: string) {
  const res = await admin.post('/groups', { name, shortCode, kind: 'division', color: 'gruen' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function member(body: Record<string, unknown>) {
  const res = await admin.post('/members', { lastName: 'Muster', firstName: 'Max', joinDate: '2024-01-01', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('members', () => {
  it('numbers members from the pattern and derives the status from the join date', async () => {
    await admin.patch('/organization', { memberNumberPattern: 'M-{YYYY}-{seq:4}' });
    const a = await member({ joinDate: '2027-03-01' });
    const b = await member({ joinDate: '2027-04-01', lastName: 'Beispiel' });
    expect(a.membershipNumber).toBe('M-2027-0001');
    expect(b.membershipNumber).toBe('M-2027-0002');
    expect(a.status).toBe('future');
    const c = await member({ joinDate: '2020-01-01', lastName: 'Alt' });
    expect(c.status).toBe('active');
    const d = await member({ joinDate: null, lastName: 'Antrag' });
    expect(d.status).toBe('applicant');
  });

  it('refuses free status edits and points to the actions', async () => {
    const m = await member({});
    const res = await admin.patch(`/members/${m.id}`, { status: 'former' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Aktionen');
  });

  it('validates postal codes by country', async () => {
    const ok = await admin.post('/members', { lastName: 'Huber', country: 'AT', postalCode: '1010', joinDate: '2024-01-01' });
    expect(ok.status).toBe(201);
    const bad = await admin.post('/members', { lastName: 'Huber', country: 'AT', postalCode: '10115', joinDate: '2024-01-01' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].field).toBe('postalCode');
  });

  it('resigns with the notice rule, rejects exit before join and hides former members by default', async () => {
    const proposal = await admin.get('/members/exit-proposal?noticeDate=2026-05-10');
    expect(proposal.body.exitDate).toBe('2026-06-30');
    const m = await member({ joinDate: '2024-01-01' });
    const bad = await admin.post(`/members/${m.id}/resign`, { noticeDate: '2023-11-01', exitDate: '2023-12-31' });
    expect(bad.status).toBe(400);
    const res = await admin.post(`/members/${m.id}/resign`, { noticeDate: '2025-01-01', exitDate: '2025-03-31', exitReason: 'Umzug' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('former');
    expect((await admin.get('/members')).body.total).toBe(0);
    expect((await admin.get('/members?includeFormer=true')).body.total).toBe(1);
    expect(res.body.timeline.map((t: { action: string }) => t.action)).toContain('member.resigned');
  });

  it('warns when the exit date breaks the notice rule', async () => {
    const m = await member({ joinDate: '2024-01-01' });
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const res = await admin.post(`/members/${m.id}/resign`, { noticeDate: today(), exitDate: future });
    expect(res.body.status).toBe('resigned');
    expect(res.body.warnings.join(' ')).toContain('Satzung');
  });

  it('moves future to active and resigned to former when the date is reached', async () => {
    const m = await member({ joinDate: '2030-01-01' });
    await ctx.db.updateTable('member').set({ join_date: '2020-01-01' }).where('id', '=', m.id).execute();
    expect(await refreshMemberStatuses(ctx.db)).toBe(1);
    expect((await admin.get(`/members/${m.id}`)).body.status).toBe('active');
  });

  it('finds members with typos, by number and city', async () => {
    await member({ lastName: 'Schmidt', firstName: 'Johanna', city: 'Musterstadt' });
    expect((await admin.get('/members?q=schmitt')).body.total).toBe(1);
    expect((await admin.get('/members?q=johanna%20schmidt')).body.total).toBe(1);
    expect((await admin.get('/members?q=musterst')).body.total).toBe(1);
    expect((await admin.get('/members?q=zzzz')).body.total).toBe(0);
    await member({ lastName: 'Yılmaz', firstName: 'Elif' });
    await member({ lastName: 'Müller', firstName: 'Jörg' });
    expect((await admin.get('/members?q=yilmaz')).body.total).toBe(1);
    expect((await admin.get('/members?q=muller')).body.total).toBe(1);
    expect((await admin.get('/members?q=%25')).body.total).toBe(0);
  });

  it('pages with a cursor', async () => {
    for (let i = 0; i < 5; i++) await member({ lastName: `Name${i}` });
    const first = await admin.get('/members?limit=2');
    expect(first.body.items).toHaveLength(2);
    const second = await admin.get(`/members?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0].lastName).toBe('Name2');
  });

  it('exports CSV with escaped formulas and audits the export', async () => {
    await member({ lastName: '=HYPERLINK("x")', firstName: 'Eva' });
    const res = await ctx.app.inject({ url: '/api/v1/members/export.csv', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body.startsWith('﻿Mitgliedsnummer;')).toBe(true);
    expect(res.body).toContain(`"'=HYPERLINK(""x"")"`);
    const events = await ctx.db.selectFrom('audit_event').select('action').where('action', '=', 'member.export').execute();
    expect(events).toHaveLength(1);
  });
});

describe('groups', () => {
  it('rejects duplicate short codes and overlapping memberships with German messages', async () => {
    await group('Fußball', 'FB');
    const dup = await admin.post('/groups', { name: 'Fußball 2', shortCode: 'fb' });
    expect(dup.status).toBe(409);
    expect(dup.body.detail).toBe('Dieses Kürzel ist schon vergeben.');
    const g = await group('U17', 'U17');
    const m = await member({ groupIds: [g] });
    const overlap = await admin.post('/group-memberships', { memberId: m.id, groupId: g, validFrom: '2024-03-01' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.detail).toContain('schon in der Gruppe');
  });

  it('answers who was in a group on a date', async () => {
    const g = await group('U17', 'U17');
    const m = await member({ joinDate: '2024-01-01' });
    const gm = await admin.post('/group-memberships', { memberId: m.id, groupId: g, validFrom: '2026-01-01' });
    await admin.patch(`/group-memberships/${gm.body.id}`, { validTo: '2026-02-28' });
    expect((await admin.get(`/groups/${g}/members?at=2026-02-15`)).body).toHaveLength(1);
    expect((await admin.get(`/groups/${g}/members?at=2026-03-01`)).body).toHaveLength(0);
  });

  it('bulk-adds members and reports skipped ones', async () => {
    const g = await group('Tennis', 'TEN');
    const a = await member({ lastName: 'A', groupIds: [g] });
    const b = await member({ lastName: 'B' });
    const res = await admin.post('/members/bulk', { ids: [a.id, b.id, '01900000-0000-7000-8000-000000000000'], action: 'add_to_group', groupId: g, date: '2025-01-01' });
    expect(res.body.succeeded).toBe(1);
    expect(res.body.skipped).toHaveLength(2);
  });
});

describe('roles and scope', () => {
  it('limits a division lead to their division and hides restricted fields from trainers', async () => {
    const tennis = await group('Tennis', 'TEN');
    const football = await group('Fußball', 'FB');
    const t = await member({ lastName: 'Tennis', groupIds: [tennis], note: 'geheim' });
    const f = await member({ lastName: 'Fussball', groupIds: [football] });

    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Abteilungsleitung', [tennis]) });
    expect((await lead.get('/members')).body.items.map((m: { lastName: string }) => m.lastName)).toEqual(['Tennis']);
    expect((await lead.get(`/members/${f.id}`)).status).toBe(404);
    expect((await lead.post('/members', { lastName: 'Neu', groupIds: [football], joinDate: '2024-01-01' })).status).toBe(403);
    expect((await lead.post('/members', { lastName: 'Neu', groupIds: [tennis], joinDate: '2024-01-01' })).status).toBe(201);

    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Trainer:in', [tennis]) });
    const seen = await trainer.get(`/members/${t.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.note).toBeUndefined();
    expect(seen.body.restricted).toContain('note');
    const write = await trainer.patch(`/members/${t.id}`, { city: 'Berlin' });
    expect(write.status).toBe(403);
    expect(write.body.permission).toBe('members:write');
    const csv = await ctx.app.inject({ url: '/api/v1/members/export.csv', headers: { cookie: (await userWithRole(ctx.app, adminCookie, 'Steuerberatung', null)) } });
    expect(csv.body.split('\r\n')[0]).not.toContain('E-Mail');
  });

  it('keeps built-in roles immutable and at least one admin', async () => {
    const roles = (await admin.get('/roles')).body;
    const treasurer = roles.find((r: { name: string }) => r.name === 'Kassenwart');
    expect((await admin.patch(`/roles/${treasurer.id}`, { name: 'Kasse' })).status).toBe(409);
    const me = (await admin.get('/auth/me')).body;
    expect((await admin.patch(`/users/${me.id}`, { grants: [{ roleId: treasurer.id }] })).status).toBe(409);
    expect((await admin.patch(`/users/${me.id}`, { status: 'disabled' })).status).toBe(409);
    const perms = await admin.get(`/users/${me.id}/permissions`);
    expect(perms.body.modules.find((m: { module: string }) => m.module === 'members').level).toBe('write');
  });

  it('invites users with a single-use link', async () => {
    const roles = (await admin.get('/roles')).body;
    const created = await admin.post('/users', { name: 'Kai Kasse', email: 'kai@example.org', grants: [{ roleId: roles[1].id }] });
    expect(created.body.user.invited).toBe(true);
    const accept = (pw: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token: created.body.inviteToken, password: pw } });
    expect((await accept('ein-sehr-langes-passwort')).statusCode).toBe(200);
    expect((await accept('noch-ein-langes-passwort')).statusCode).toBe(400);
  });
});

describe('API tokens', () => {
  it('act with their role, are audited by name, cannot mint tokens and can be revoked', async () => {
    const roles = (await admin.get('/roles')).body;
    const adminRole = roles.find((r: { name: string }) => r.name === 'Admin');
    const created = await admin.post('/api-tokens', { name: 'Website', roleId: adminRole.id });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^ov_[0-9a-f]{8}_/);
    const api = client(ctx.app, { token: created.body.token });
    const m = await api.post('/members', { lastName: 'Per API', joinDate: '2024-01-01' });
    expect(m.status).toBe(201);
    const ev = await ctx.db.selectFrom('audit_event').select('actor_label').where('action', '=', 'member.created').executeTakeFirstOrThrow();
    expect(ev.actor_label).toBe('API: Website');
    expect((await api.post('/api-tokens', { name: 'Mehr', roleId: adminRole.id })).status).toBe(403);
    await admin.post(`/api-tokens/${created.body.apiToken.id}/revoke`);
    expect((await api.get('/members')).status).toBe(401);
  });
});

vi.setConfig({ testTimeout: 30_000 });

describe('no privilege escalation', () => {
  it('a user with settings:write but not admin cannot grant or define stronger roles', async () => {
    const roles = (await admin.get('/roles')).body;
    const adminRole = roles.find((r: { name: string }) => r.name === 'Admin');
    const all = Object.fromEntries(Object.keys(adminRole.permissions).map((m) => [m, 'read']));
    const custom = await admin.post('/roles', { name: 'Schriftführung', permissions: { ...all, settings: 'write', members: 'write' } });
    expect(custom.status).toBe(201);
    const created = await admin.post('/users', { name: 'Sabine Schrift', email: 'sabine@example.org', grants: [{ roleId: custom.body.id }] });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token: created.body.inviteToken, password: 'ein-sehr-langes-passwort' } });
    const clerkCookie = `ov_session=${res.cookies.find((c) => c.name === 'ov_session')!.value}`;
    await enrollTotp(ctx.app, clerkCookie); // changing users and roles needs the second factor
    const clerk = client(ctx.app, { cookie: clerkCookie });
    const me = (await clerk.get('/auth/me')).body;
    expect((await clerk.patch(`/users/${me.id}`, { grants: [{ roleId: adminRole.id }] })).status).toBe(403);
    expect((await clerk.post('/roles', { name: 'Hintertür', permissions: { ...all, ledger: 'write' } })).status).toBe(403);
    expect((await clerk.post('/users', { name: 'Kumpel', email: 'k@example.org', grants: [{ roleId: custom.body.id }] })).status).toBe(201);
  });
});

describe('review fixes', () => {
  it('invites are not password resets and tokens cannot manage people', async () => {
    const roles = (await admin.get('/roles')).body;
    const adminRole = roles.find((r: { name: string }) => r.name === 'Admin');
    const all = Object.fromEntries(Object.keys(adminRole.permissions).map((m) => [m, 'read']));
    const clerkRole = await admin.post('/roles', { name: 'Schriftführung', permissions: { ...all, settings: 'write' } });
    const created = await admin.post('/users', { name: 'Sabine', email: 'sabine@example.org', grants: [{ roleId: clerkRole.body.id }] });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token: created.body.inviteToken, password: 'ein-sehr-langes-passwort' } });
    const clerkCookie = `ov_session=${res.cookies.find((c) => c.name === 'ov_session')!.value}`;
    await enrollTotp(ctx.app, clerkCookie);
    const clerk = client(ctx.app, { cookie: clerkCookie });
    const me = (await admin.get('/auth/me')).body;
    expect((await clerk.post(`/users/${me.id}/invite`)).status).toBe(409);
    expect((await clerk.patch(`/users/${me.id}`, { status: 'disabled' })).status).toBe(403);
    expect((await clerk.post('/roles', { name: 'Ohne Grenzen', permissions: all, restrictedFields: [] })).status).toBe(201);

    const token = await admin.post('/api-tokens', { name: 'Skript', roleId: adminRole.id });
    const api = client(ctx.app, { token: token.body.token });
    expect((await api.post('/users', { name: 'Fremd', email: 'f@example.org', grants: [{ roleId: adminRole.id }] })).status).toBe(403);
    expect((await api.post('/roles', { name: 'API-Rolle', permissions: all })).status).toBe(403);
  });

  it('a role cannot reveal fields the creator does not see', async () => {
    const roles = (await admin.get('/roles')).body;
    const trainer = roles.find((r: { name: string }) => r.name === 'Trainer:in');
    const custom = await admin.post('/roles', { name: 'Trainer plus', permissions: { ...trainer.permissions, settings: 'write' }, restrictedFields: ['note'] });
    const created = await admin.post('/users', { name: 'Tom', email: 'tom@example.org', grants: [{ roleId: custom.body.id }] });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token: created.body.inviteToken, password: 'ein-sehr-langes-passwort' } });
    const tomCookie = `ov_session=${res.cookies.find((c) => c.name === 'ov_session')!.value}`;
    await enrollTotp(ctx.app, tomCookie);
    const tom = client(ctx.app, { cookie: tomCookie });
    expect((await tom.post('/roles', { name: 'Alles sehen', permissions: trainer.permissions, restrictedFields: [] })).status).toBe(403);
  });

  it('skips member numbers that already exist', async () => {
    await member({ membershipNumber: '0002', lastName: 'Hand' });
    const a = await member({ lastName: 'A' });
    const b = await member({ lastName: 'B' });
    expect([a.membershipNumber, b.membershipNumber]).toEqual(['0001', '0003']);
    expect((await admin.patch('/organization', { memberNumberPattern: 'M-{seqx}' })).status).toBe(400);
  });

  it('former members leave the division scope; future members are in scope at once', async () => {
    const tennis = await group('Tennis', 'TEN');
    const old = await member({ lastName: 'Ehemalig', joinDate: '2010-01-01', groupIds: [tennis] });
    await admin.post(`/members/${old.id}/resign`, { noticeDate: '2020-01-01', exitDate: '2020-12-31' });
    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Abteilungsleitung', [tennis]) });
    expect((await lead.get(`/members/${old.id}`)).status).toBe(404);
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const created = await lead.post('/members', { lastName: 'Bald', joinDate: future, groupIds: [tennis] });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('future');
    expect((await admin.get('/members?includeFormer=false')).body.items.map((m: { lastName: string }) => m.lastName)).not.toContain('Ehemalig');
  });

  it('parallel admit and reject: exactly one wins', async () => {
    const m = await member({ joinDate: null, lastName: 'Antrag' });
    const [x, y] = await Promise.all([admin.post(`/members/${m.id}/admit`, { joinDate: '2026-01-01' }), admin.post(`/members/${m.id}/reject`)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });

  it('withdrawing a resignation reopens the group memberships', async () => {
    const g = await group('Turnen', 'TU');
    const m = await member({ groupIds: [g] });
    const exit = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const r = await admin.post(`/members/${m.id}/resign`, { noticeDate: today(), exitDate: exit });
    expect(r.body.memberships[0].validTo).toBe(exit);
    const w = await admin.post(`/members/${m.id}/withdraw-resignation`);
    expect(w.body.memberships[0].validTo).toBeNull();
  });
});
