import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, reset, setupClub, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());
const csv = await readFile(new URL('./fixtures/easyverein-members.csv', import.meta.url), 'utf8');

let admin: ReturnType<typeof client>;
beforeEach(async () => {
  await reset(ctx.db);
  admin = client(ctx.app, { cookie: (await setupClub(ctx.app)).cookie });
});

describe('member import', () => {
  it('previews without writing, maps easyVerein headers and reports row errors', async () => {
    const p = await admin.post('/imports/members/preview', { content: csv, preset: 'easyverein', fileName: 'mitglieder.csv' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.unmapped).toEqual(['Lieblingsfarbe']);
    expect(p.body.counts).toEqual({ create: 2, update: 0, skip: 0, error: 2 });
    expect(p.body.newGroups.sort()).toEqual(['Fußball', 'Tennis', 'Vorstand']);
    const dora = p.body.rows.find((r: { name: string }) => r.name.startsWith('Dachs'));
    expect(dora.messages).toEqual(expect.arrayContaining(['Geburtsdatum „30.02.1990“ ist kein Datum.', 'IBAN ist ungültig.']));
    expect((await admin.get('/members')).body.total).toBe(0);
  });

  it('imports members, groups and signed mandates, updates by number on a second run, and rolls back', async () => {
    const r = await admin.post('/imports/members', { content: csv, preset: 'easyverein' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const list = (await admin.get('/members?includeFormer=true&limit=50')).body.items as { name: string; status: string; membershipNumber: string }[];
    expect(list.map((m) => m.membershipNumber).sort()).toEqual(['1001', '1002']);
    expect(list.find((m) => m.membershipNumber === '1002')!.status).toBe('former');
    const mandate = await ctx.db.selectFrom('sepa_mandate').selectAll().executeTakeFirstOrThrow();
    expect(mandate).toMatchObject({ reference: 'M-1001', signed_on: '2015-04-01', status: 'active', account_holder: 'Anna Becker' });

    const again = await admin.post('/imports/members/preview', { content: csv.replace('Lindenallee 1', 'Lindenallee 9') });
    expect(again.body.counts).toMatchObject({ create: 0, update: 2 });
    const second = await admin.post('/imports/members', { content: csv.replace('Lindenallee 1', 'Lindenallee 9') });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const anna = (await admin.get('/members?q=becker')).body.items[0];
    expect((await admin.get(`/members/${anna.id}`)).body.street).toBe('Lindenallee 9');

    // The first run created the members; nothing depends on them yet except the second run's group rows.
    const runs = (await admin.get('/imports')).body as { id: string }[];
    const firstRun = runs[runs.length - 1]!;
    const rb = await admin.post(`/imports/${firstRun.id}/rollback`, {});
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect((await admin.get('/members?includeFormer=true')).body.total).toBe(0);
    expect((await admin.get('/groups')).body).toHaveLength(0);
  });

  it('refuses a rollback once invoices exist', async () => {
    const r = await admin.post('/imports/members', { content: csv });
    const anna = (await admin.get('/members?q=becker')).body.items[0];
    const d = await admin.post('/invoices', { memberId: anna.id, lines: [{ text: 'Beitrag', unitCents: 1000 }] });
    expect(d.status).toBe(201);
    const rb = await admin.post(`/imports/${r.body.id}/rollback`, {});
    expect(rb.status).toBe(409);
    expect(rb.body.detail).toContain('Rechnungen');
  });
});
