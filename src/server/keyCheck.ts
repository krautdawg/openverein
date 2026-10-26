import { sql } from 'kysely';
import { dataKeyCheck, decrypt, decryptBytes } from './crypto.ts';
import type { Db } from './db.ts';

const WRONG_KEY = 'DATA_KEY passt nicht zu dieser Datenbank. Setze den DATA_KEY, mit dem sie angelegt wurde (siehe docs/operations.md).';

/**
 * Stops the start when DATA_KEY is not the key this database was written with (a restore with the wrong key,
 * a lost .env): otherwise bank details would be unreadable and new ones written with a second key.
 * A database without a fingerprint yet (new, or from before the check existed) gets one only after one stored
 * value of every encrypted column decrypts with this key; a wrong key is never blessed.
 */
export async function verifyDataKey(db: Db): Promise<'stored' | 'ok'> {
  const check = dataKeyCheck();
  const row = await db.selectFrom('instance_setting').select('value').where('key', '=', 'data_key_check').executeTakeFirst();
  if (!row) {
    await assertExistingDataDecrypts(db);
    await db.insertInto('instance_setting').values({ key: 'data_key_check', value: check }).onConflict((oc) => oc.doNothing()).execute();
    // Two instances starting at once: whoever stored first wins, and the other must agree.
    const stored = await db.selectFrom('instance_setting').select('value').where('key', '=', 'data_key_check').executeTakeFirstOrThrow();
    if (stored.value !== check) throw new Error(WRONG_KEY);
    return 'stored';
  }
  if (row.value !== check) throw new Error(WRONG_KEY);
  return 'ok';
}

async function assertExistingDataDecrypts(db: Db) {
  // Columns named *_encrypted, plus the issued XRechnung (encrypted bytes without the suffix).
  const cols = (await sql<{ t: string; c: string; bytes: boolean }>`
    select table_name as t, column_name as c, data_type = 'bytea' as bytes from information_schema.columns
    where table_schema = 'public' and (column_name like '%\_encrypted' or (table_name = 'invoice_einvoice' and column_name = 'xml'))`.execute(db)).rows;
  for (const { t, c, bytes } of cols) {
    const v = (await sql<{ v: string | Buffer }>`select ${sql.ref(c)} as v from ${sql.table(t)} where ${sql.ref(c)} is not null limit 1`.execute(db)).rows[0]?.v;
    if (v === undefined) continue;
    try {
      if (bytes) decryptBytes(v as Buffer);
      else if (v !== '') decrypt(v as string);
    } catch {
      throw new Error(`${WRONG_KEY} (${t}.${c} lässt sich nicht entschlüsseln)`);
    }
  }
}
