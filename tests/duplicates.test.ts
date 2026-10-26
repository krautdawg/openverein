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

  it('hides restricted fields, archives an applicant as rejected, ends groups, ends fees, refuses unrelated pairs and new invoices for the archived, and refuses crossed resolves', async () => {
    const plan = (await admin.post('/fee-plans', { name: 'Erwachsene', version: { validFrom: '2020-01-01', amountCents: 12000, intervalMonths: 12 } })).body.id;
    const group = (await admin.post('/groups', { name: 'Tennis', shortCode: 'TEN' })).body.id;
    const a = (await admin.post('/members', { firstName: 'Paul', lastName: 'Paar', birthDate: '1980-01-01', email: 'pp@example.org', joinDate: '2015-01-01' })).body;
    const b = (await admin.post('/members', { firstName: 'Paul', lastName: 'Paar', birthDate: '1980-01-01', email: 'pp@example.org', joinDate: '2024-01-01', groupIds: [group] })).body;
    await admin.post(`/members/${b.id}/fee-assignments`, { feePlanId: plan, validFrom: '2024-01-01' });
    const applicant = (await admin.post('/members', { firstName: 'Paul', lastName: 'Paar', birthDate: '1980-01-01', email: 'pp@example.org' })).body;
    expect(applicant.status).toBe('applicant');

    const adviser = client(ctx.app, { cookie: await userWithRole(ctx.app, cookie, 'Steuerberatung', null) });
    // Scores and even which pairs appear would reveal the fields the adviser's role hides.
    expect((await adviser.get('/members/duplicates?threshold=60')).status).toBe(403);
    // Only a pair the search would propose can be archived.
    const stranger = (await admin.post('/members', { firstName: 'Zora', lastName: 'Zander', joinDate: '2020-01-01' })).body;
    expect((await admin.post('/members/duplicates/resolve', { keepPersonId: a.personId, archivePersonId: stranger.personId })).body.type).toMatch(/not-a-duplicate$/);

    expect((await admin.post('/members/duplicates/resolve', { keepPersonId: a.personId, archivePersonId: applicant.personId })).status).toBe(204);
    expect((await admin.get(`/members/${applicant.id}`)).body.status).toBe('rejected');

    expect((await admin.post('/members/duplicates/resolve', { keepPersonId: a.personId, archivePersonId: b.personId })).status).toBe(204);
    // The started fee assignment ends with the membership; history stays.
    const fees = await ctx.db.selectFrom('fee_assignment').select('valid_to').where('member_id', '=', b.id).execute();
    expect(fees).toHaveLength(1);
    expect(fees[0]!.valid_to).not.toBeNull();
    // An archived duplicate gets no new financial records.
    const inv = await admin.post('/invoices', { memberId: b.id, lines: [{ text: 'Beitrag', unitCents: 100 }] });
    expect(inv.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(inv.body)).toContain('Dublette archiviert');
    const gm = await ctx.db.selectFrom('group_membership').select('valid_to').where('member_id', '=', b.id).execute();
    expect(gm.every((g) => g.valid_to !== null)).toBe(true);
    // The opposite click on the same pair is refused.
    expect((await admin.post('/members/duplicates/resolve', { keepPersonId: b.personId, archivePersonId: a.personId })).status).toBe(409);
  });
});
