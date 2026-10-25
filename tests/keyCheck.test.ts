import { afterAll, describe, expect, it } from 'vitest';
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
});
