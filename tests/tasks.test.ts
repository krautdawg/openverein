import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setMailer } from '../src/server/mail/transport.ts';
import { client, reset, setupClub, testApp, userWithRole } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';

let admin: ReturnType<typeof client>;
let adminCookie: string;
beforeEach(async () => {
  await reset(ctx.db);
  setMailer(null);
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  adminCookie = (await setupClub(ctx.app)).cookie;
  admin = client(ctx.app, { cookie: adminCookie });
});

describe('tasks', () => {
  it('assigns with a mail, lets creator, assignee and admins edit, and hides members the viewer may not read', async () => {
    const tennis = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN', kind: 'division' })).body.id;
    const fussball = (await admin.post('/groups', { name: 'Fußball', shortCode: 'FB', kind: 'division' })).body.id;
    const m = (await admin.post('/members', { firstName: 'Tim', lastName: 'Torwart', joinDate: '2024-01-01' })).body.id;
    await admin.post('/group-memberships', { memberId: m, groupId: fussball, validFrom: '2024-01-01' });
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Trainer:in', [tennis]) });
    const trainerId = (await admin.get('/tasks/assignees')).body.find((u: { name: string }) => u.name.startsWith('Trainer')).id;
    const t = await admin.post('/tasks', { title: 'Trikots bestellen', dueOn: '2026-01-15', assigneeUserId: trainerId, memberId: m });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body).toMatchObject({ overdue: true, assignee: { id: trainerId }, member: { id: m } });
    await new Promise((r) => setTimeout(r, 300));
    const mails = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('subject:"Neue Aufgabe"')}`)).json()).messages as unknown[];
    expect(mails).toHaveLength(1);
    // The trainer sees the task, but not the Fußball member linked to it.
    const seen = (await trainer.get('/tasks?filter=mine')).body;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ member: null, canEdit: true });
    expect((await trainer.patch(`/tasks/${t.body.id}`, { done: true })).body.done).toBe(true);
    expect((await trainer.del(`/tasks/${t.body.id}`)).status).toBe(403);
    // Someone else cannot edit a task that is not theirs.
    const own = await trainer.post('/tasks', { title: 'Hallenschlüssel abholen' });
    const lead = client(ctx.app, { cookie: await userWithRole(ctx.app, adminCookie, 'Abteilungsleitung', [tennis]) });
    expect((await lead.patch(`/tasks/${own.body.id}`, { done: true })).status).toBe(403);
    expect((await admin.get('/tasks?filter=done')).body).toHaveLength(1);
    expect((await admin.del(`/tasks/${t.body.id}`)).status).toBe(204);
  });
});
