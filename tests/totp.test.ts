import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, enrollTotp, reset, setupClub, testApp, totpNow } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

let adminCookie: string;
let admin: ReturnType<typeof client>;
let adminSecret: string;
beforeEach(async () => {
  await reset(ctx.db);
  const s = await setupClub(ctx.app);
  adminCookie = s.cookie;
  adminSecret = s.totp.secret;
  admin = client(ctx.app, { cookie: adminCookie });
});

async function invite(roleName: string) {
  const roles = (await admin.get('/roles')).body as { id: string; name: string }[];
  const created = await admin.post('/users', { name: `${roleName} Test`, email: `${roleName.toLowerCase().replace(/\W/g, '')}@example.org`, grants: [{ roleId: roles.find((r) => r.name === roleName)!.id }] });
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token: created.body.inviteToken, password: 'ein-sehr-langes-passwort' } });
  return `ov_session=${res.cookies.find((c) => c.name === 'ov_session')!.value}`;
}

describe('TOTP', () => {
  it('keeps finance closed for a treasurer until TOTP is set up, on every request', async () => {
    const cookie = await invite('Kassenwart');
    const kasse = client(ctx.app, { cookie });
    expect((await kasse.get('/auth/me')).body.mfa).toEqual({ required: true, enrolled: false });
    const refused = await kasse.get('/invoices');
    expect(refused.status).toBe(403);
    expect(refused.body.type).toContain('totp-required');
    expect((await kasse.get('/members')).status).toBe(200); // non-finance data stays open
    await enrollTotp(ctx.app, cookie);
    expect((await kasse.get('/invoices')).status).toBe(200);
  });

  it('accepts a recovery code once and never the same TOTP step twice', async () => {
    const { recoveryCodes } = await enrollTotp(ctx.app, adminCookie);
    const ticket = async () => (await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'erika@example.org', password: 'korrekt-pferd-batterie' } })).json().ticket;
    const finish = async (code: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login/totp', payload: { ticket: await ticket(), code } });
    expect((await finish(recoveryCodes[0]!)).statusCode).toBe(200);
    expect((await finish(recoveryCodes[0]!)).statusCode).toBe(401);
    void adminSecret;
  });

  it('asks for a fresh code before critical actions', async () => {
    const roles = (await admin.get('/roles')).body as { id: string; name: string }[];
    const adminRole = roles.find((r) => r.name === 'Admin')!;
    expect((await admin.post('/api-tokens', { name: 'jetzt', roleId: adminRole.id })).status).toBe(201);
    await ctx.db.updateTable('session').set({ mfa_at: new Date(Date.now() - 25 * 60_000) }).execute();
    const stale = await admin.post('/api-tokens', { name: 'später', roleId: adminRole.id });
    expect(stale.status).toBe(403);
    expect(stale.body.type).toContain('step-up-required');
    expect((await admin.post('/auth/step-up', { code: '000000' })).status).toBe(400);
    expect((await admin.post('/auth/step-up', { code: totpNow(adminSecret, 1) })).status).toBe(200);
    expect((await admin.post('/api-tokens', { name: 'später', roleId: adminRole.id })).status).toBe(201);
  });

  it('lists sessions and signs out the others', async () => {
    const other = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'erika@example.org', password: 'korrekt-pferd-batterie' } });
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login/totp', payload: { ticket: other.json().ticket, code: totpNow(adminSecret, 1) } });
    expect((await admin.get('/auth/sessions')).body).toHaveLength(2);
    expect((await admin.post('/auth/sessions/revoke-others', {})).body.revoked).toBe(1);
    expect((await admin.get('/auth/sessions')).body).toHaveLength(1);
  });
});
