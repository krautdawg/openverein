import { dataKeyCheck } from './crypto.ts';
import type { Db } from './db.ts';

/**
 * Stops the start when DATA_KEY is not the key this database was written with (a restore with the wrong key,
 * a lost .env): otherwise bank details would be unreadable and new ones written with a second key.
 * The first start of a database stores the fingerprint.
 */
export async function verifyDataKey(db: Db): Promise<'stored' | 'ok'> {
  const check = dataKeyCheck();
  const row = await db.selectFrom('instance_setting').select('value').where('key', '=', 'data_key_check').executeTakeFirst();
  if (!row) {
    await db.insertInto('instance_setting').values({ key: 'data_key_check', value: check }).onConflict((oc) => oc.doNothing()).execute();
    return 'stored';
  }
  if (row.value !== check) throw new Error('DATA_KEY passt nicht zu dieser Datenbank. Setze den DATA_KEY, mit dem sie angelegt wurde (siehe docs/operations.md).');
  return 'ok';
}
