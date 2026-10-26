import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../src/shared/dates.ts';
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
const today = () => new Date().toISOString().slice(0, 10);

describe('general assembly', () => {
  it('invites within the notice period, records attendance and votes, closes and freezes the minutes', async () => {
    const a = (await admin.post('/members', { firstName: 'Anna', lastName: 'Anwesend', email: 'anna@example.org', joinDate: '2020-01-01' })).body;
    await admin.post('/members', { firstName: 'Bert', lastName: 'Brief', joinDate: '2020-01-01' });
    const input = { title: 'Ordentliche Mitgliederversammlung 2027', heldOn: addDays(today(), 30), startsAt: '19:30', place: 'Vereinsheim', noticeDays: 14, items: [{ title: 'Bericht des Vorstands' }, { title: 'Entlastung des Vorstands', isVote: true }] };
    const created = await admin.post('/assemblies', input);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ inviteBy: addDays(today(), 16), eligible: 2 });

    // Too late: the notice period cannot be kept.
    const late = (await admin.post('/assemblies', { ...input, heldOn: addDays(today(), 7) })).body;
    expect((await admin.post(`/assemblies/${late.id}/invite`, {})).status).toBe(409);

    const inv = await admin.post(`/assemblies/${created.body.id}/invite`, {});
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(inv.body.sent).toBe(1);
    expect(inv.body.letters).toEqual([expect.objectContaining({ name: 'Brief, Bert', reason: 'keine E-Mail-Adresse' })]);
    const msg = await ctx.db.selectFrom('message').select(['subject', 'body']).executeTakeFirstOrThrow();
    expect(msg.subject).toContain('Einladung: Ordentliche Mitgliederversammlung 2027');
    expect(msg.body).toContain('2. Entlastung des Vorstands');
    expect((await admin.put(`/assemblies/${created.body.id}`, input)).status).toBe(409);

    // Only who could take part that day: someone who joins later is refused.
    const later = (await admin.post('/members', { lastName: 'Spaeter', joinDate: addDays(today(), 60) })).body;
    expect((await admin.put(`/assemblies/${created.body.id}/attendance`, { memberIds: [a.id, later.id] })).status).toBe(400);
    await admin.put(`/assemblies/${created.body.id}/attendance`, { memberIds: [a.id] });
    const vote = created.body.items[1].id;
    await admin.put(`/assemblies/${created.body.id}/items/${vote}`, { votesYes: 1, votesNo: 0, votesAbstain: 0, outcome: 'Der Vorstand ist entlastet.' });
    const closed = await admin.post(`/assemblies/${created.body.id}/close`, { chair: 'Erika Mustermann', minutesBy: 'Max Muster' });
    expect(closed.body).toMatchObject({ attendees: [a.id], chair: 'Erika Mustermann' });
    expect((await admin.put(`/assemblies/${created.body.id}/items/${vote}`, { votesYes: 5, votesNo: 0, votesAbstain: 0, outcome: null })).status).toBe(409);
    // The closed assembly row itself is frozen too, and a closed one is not invited.
    await expect(ctx.db.updateTable('assembly').set({ title: 'Anders' }).where('id', '=', created.body.id).execute()).rejects.toThrow(/closed/);
    const pdf = await ctx.app.inject({ url: `/api/v1/assemblies/${created.body.id}/minutes.pdf`, headers: { cookie } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Trainer:in', null) });
    expect((await trainer.post('/assemblies', input)).status).toBe(403);
  });

  it('invites a board meeting to its group only and counts that group', async () => {
    const board = (await admin.post('/groups', { name: 'Vorstand', shortCode: 'VS', kind: 'board' })).body.id;
    await admin.post('/members', { firstName: 'Vera', lastName: 'Vorsitz', email: 'vera@example.org', joinDate: '2020-01-01', groupIds: [board] });
    await admin.post('/members', { firstName: 'Max', lastName: 'Mitglied', email: 'max@example.org', joinDate: '2020-01-01' });
    const input = { kind: 'board', groupId: board, title: 'Vorstandssitzung', heldOn: addDays(today(), 10), startsAt: '19:00', place: 'Online', noticeDays: 7, items: [{ title: 'Beschlüsse', isVote: true }] };
    expect((await admin.post('/assemblies', { ...input, groupId: null })).status).toBe(400);
    const m = await admin.post('/assemblies', input);
    expect(m.body).toMatchObject({ kind: 'board', eligible: 1 });
    expect((await admin.post(`/assemblies/${m.body.id}/invite`, {})).body.sent).toBe(1);
    const to = await ctx.db.selectFrom('delivery').select('email').execute();
    expect(to.map((d) => d.email)).toEqual(['vera@example.org']);
  });
});
