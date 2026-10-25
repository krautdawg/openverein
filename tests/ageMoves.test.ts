import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyAgeMoves } from '../src/server/members/ageMoves.ts';
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

const iso = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (years: number, days = 0) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - years); d.setUTCDate(d.getUTCDate() + days); return iso(d); };

describe('age-based group change', () => {
  it('previews and applies moves on the birthday, leaves later additions alone, and validates the rule', async () => {
    const adults = (await admin.post('/groups', { name: 'Erwachsene', shortCode: 'ERW', kind: 'segment' })).body.id;
    const youth = (await admin.post('/groups', { name: 'Jugend', shortCode: 'JUG', kind: 'segment', nextGroupId: adults, nextGroupAge: 18, nextGroupOn: 'birthday' })).body;
    expect(youth.nextGroupAge).toBe(18);
    expect((await admin.post('/groups', { name: 'Halb', shortCode: 'HALB', nextGroupId: adults })).status).toBe(409);

    // Turned 18 yesterday (due), turns 18 in 30 days (upcoming), already 18 when added (left alone).
    const due = (await admin.post('/members', { lastName: 'Faellig', birthDate: yearsAgo(18, -1), joinDate: yearsAgo(5), groupIds: [youth.id] })).body.id;
    const soon = (await admin.post('/members', { lastName: 'Bald', birthDate: yearsAgo(18, 30), joinDate: yearsAgo(5), groupIds: [youth.id] })).body.id;
    await admin.post('/members', { lastName: 'Bewusst', birthDate: yearsAgo(30), joinDate: yearsAgo(1), groupIds: [youth.id] });

    const preview = (await admin.get(`/groups/${youth.id}/age-moves`)).body as { memberId: string; moveOn: string }[];
    expect(preview.map((p) => p.memberId)).toEqual([due, soon]);
    expect(preview[0]!.moveOn).toBe(iso(new Date()));

    expect(await applyAgeMoves(ctx.db)).toBe(1);
    expect(await applyAgeMoves(ctx.db)).toBe(0);
    const detail = (await admin.get(`/members/${due}`)).body as { memberships: { groupName: string; validTo: string | null }[] };
    expect(detail.memberships.find((m) => m.groupName === 'Jugend')!.validTo).toBe(iso(new Date(Date.now() - 86_400_000)));
    expect(detail.memberships.find((m) => m.groupName === 'Erwachsene')!.validTo).toBeNull();

    // Without the birth-date right, no preview (it would give birthdays away).
    const trainer = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Steuerberatung', null) });
    expect((await trainer.get(`/groups/${youth.id}/age-moves`)).status).toBe(403);
  });
});
