import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/server/config.ts';
import { anonymise } from '../src/server/gdpr/service.ts';
import { reset, testApp } from './helpers.ts';

/** Findings of the second (Codex) review of group G18 (#113, #114). Each test failed on the code before the fix. */
config.filesDir = await mkdtemp(join(tmpdir(), 'ov-g18b-'));
const ctx = await testApp();
const TOKEN = 'o'.repeat(40);
afterAll(() => {
  config.multiTenant = false;
  config.operatorToken = '';
  return ctx.close();
});
beforeEach(async () => {
  await reset(ctx.db);
  config.multiTenant = true;
  config.operatorToken = TOKEN;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('G18 second review', () => {
  it('records an operator export before an erasure that comes in meanwhile, never after it', async () => {
    const t = await ctx.app.inject({ method: 'POST', url: '/api/v1/operator/tenants', headers: { 'x-operator-token': TOKEN }, payload: { clubName: 'TSV A', hostname: 'verein-a.example.org', adminName: 'Ada Admin', adminEmail: 'admin@verein-a.example.org' } });
    expect(t.statusCode, t.body).toBe(201);
    const org = t.json().id as string;
    const person = await ctx.db.insertInto('person').values({ organization_id: org, last_name: 'Export' }).returning('id').executeTakeFirstOrThrow();
    // The export's record is slowed down; an erasure starts while it is being written.
    await sql.raw(`create function debt_slow() returns trigger language plpgsql as $$ begin perform pg_sleep(0.4); return new; end $$;
      create trigger debt_slow before insert on operator_event for each row when (new.action = 'tenant.exported') execute function debt_slow();`).execute(ctx.db);
    const order: string[] = [];
    try {
      const exp = ctx.app.inject({ url: `/api/v1/operator/tenants/${org}/export.zip`, headers: { 'x-operator-token': TOKEN } }).then((r) => (order.push('export'), r));
      // Wait until the export is inside its insert (it holds its locks there).
      for (let i = 0; i < 100; i++) {
        const busy = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where query like '%insert into "operator_event"%' and state = 'active' and pid <> pg_backend_pid()`.execute(ctx.db);
        if (busy.rows[0]!.n > 0) break;
        await sleep(20);
      }
      const erase = ctx.db.transaction().execute((tx) => anonymise(tx, org, person.id)).then(() => order.push('erasure'));
      const r = await exp;
      await erase;
      expect(r.statusCode).toBe(200);
      // The erasure waited for the export to be recorded: the archive was handed over before the person was erased.
      expect(order).toEqual(['export', 'erasure']);
    } finally {
      await sql.raw('drop trigger debt_slow on operator_event; drop function debt_slow();').execute(ctx.db);
    }
  });
});
