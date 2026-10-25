import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let admin: ReturnType<typeof client>;
beforeEach(async () => {
  await reset(ctx.db);
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
});

describe('duplicates', () => {
  it('scores likely duplicates, honours the threshold, remembers dismissals and archives the one without financial records', async () => {
    const a = (await admin.post('/members', { firstName: 'Jürgen', lastName: 'Müller', birthDate: '1970-04-02', email: 'jm@example.org', street: 'Lindenweg 3', postalCode: '12345', city: 'Musterstadt', joinDate: '2010-01-01' })).body;
    const b = (await admin.post('/members', { firstName: 'Juergen', lastName: 'Mueller', birthDate: '1970-04-02', email: 'JM@example.org', street: 'Lindenweg  3', postalCode: '12345', city: 'Musterstadt', joinDate: '2024-01-01' })).body;
    const c = (await admin.post('/members', { firstName: 'Jana', lastName: 'Müller', birthDate: '2001-09-09', joinDate: '2020-01-01' })).body;
    const pairs = (await admin.get('/members/duplicates?threshold=60')).body as { score: number; matches: string[]; a: { personId: string }; b: { personId: string } }[];
    const ab = pairs.find((p) => [p.a.personId, p.b.personId].sort().join() === [a.personId, b.personId].sort().join())!;
    expect(ab.score).toBeGreaterThanOrEqual(90);
    expect(ab.matches).toEqual(expect.arrayContaining(['birthDate', 'email', 'address']));
    expect(pairs.some((p) => [p.a.personId, p.b.personId].includes(c.personId) && p.score >= 60)).toBe(false);
    expect((await admin.get('/members/duplicates?threshold=100')).body.length).toBeLessThanOrEqual(1);

    // The older record has an invoice: it cannot be archived, the newer one can.
    await admin.post('/invoices', { memberId: a.id, lines: [{ text: 'Beitrag', unitCents: 1000 }] });
    const blocked = await admin.post('/members/duplicates/resolve', { keepPersonId: b.personId, archivePersonId: a.personId });
    expect(blocked.body.blockers).toEqual(['Rechnungen']);
    expect((await admin.post('/members/duplicates/resolve', { keepPersonId: a.personId, archivePersonId: b.personId })).status).toBe(204);
    const archived = (await admin.get(`/members/${b.id}`)).body;
    expect(archived.status).toBe('former');
    expect(archived.exitReason).toBe(`Dublette von Nr. ${a.membershipNumber}`);
    expect((await admin.get('/members/duplicates?threshold=60')).body.some((p: { a: { personId: string }; b: { personId: string } }) => [p.a.personId, p.b.personId].includes(b.personId))).toBe(false);
  });

  it('does not propose a dismissed pair again', async () => {
    const a = (await admin.post('/members', { firstName: 'Anna', lastName: 'Schmidt', birthDate: '1990-01-01', joinDate: '2020-01-01' })).body;
    const b = (await admin.post('/members', { firstName: 'Anna', lastName: 'Schmidt', birthDate: '1990-01-01', joinDate: '2021-01-01' })).body;
    expect((await admin.get('/members/duplicates?threshold=60')).body).toHaveLength(1);
    expect((await admin.post('/members/duplicates/dismiss', { personA: b.personId, personB: a.personId })).status).toBe(204);
    expect((await admin.get('/members/duplicates?threshold=60')).body).toHaveLength(0);
  });
});
