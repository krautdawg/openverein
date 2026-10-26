import { afterAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/server/crypto.ts';
import { verifyDataKey } from '../src/server/keyCheck.ts';
import { reset, testApp } from './helpers.ts';

const ctx = await testApp();
afterAll(() => ctx.close());

describe('data key check', () => {
  it('stores the fingerprint once and refuses a database written with another key', async () => {
    await reset(ctx.db);
    expect(await verifyDataKey(ctx.db)).toBe('stored');
    expect(await verifyDataKey(ctx.db)).toBe('ok');
    await ctx.db.updateTable('instance_setting').set({ value: 'f'.repeat(64) }).where('key', '=', 'data_key_check').execute();
    await expect(verifyDataKey(ctx.db)).rejects.toThrow('DATA_KEY passt nicht');
  });

  it('never blesses a wrong key for a database from before the check (data that does not decrypt)', async () => {
    await reset(ctx.db);
    const org = await ctx.db.insertInto('organization').values({ name: 'Alt e.V.' }).returning('id').executeTakeFirstOrThrow();
    // Written with another key: a valid-looking ciphertext this key cannot open.
    await ctx.db.updateTable('organization').set({ oidc_client_secret_encrypted: 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA' }).where('id', '=', org.id).execute();
    await expect(verifyDataKey(ctx.db)).rejects.toThrow('organization.oidc_client_secret_encrypted');
    expect(await ctx.db.selectFrom('instance_setting').select('key').where('key', '=', 'data_key_check').executeTakeFirst()).toBeUndefined();
    // Data written with this key: the fingerprint is stored.
    await ctx.db.updateTable('organization').set({ oidc_client_secret_encrypted: encrypt('geheim') }).where('id', '=', org.id).execute();
    expect(await verifyDataKey(ctx.db)).toBe('stored');
  });
});
