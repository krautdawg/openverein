import { buildApp } from './app.ts';
import { config } from './config.ts';
import { assertDataKey } from './crypto.ts';
import { verifyDataKey } from './keyCheck.ts';
import { createDb } from './db.ts';
import { sweepFiles } from './files/store.ts';
import { pruneSignIns } from './routes/portal.ts';
import { pruneAgentCalls } from './agents/tokens.ts';
import { pruneApplications } from './routes/applications.ts';
import { startMailWorker } from './mail/worker.ts';
import { pruneJobs, startJobWorker } from './jobs/worker.ts';
import { pruneWebhookDeliveries, startWebhookWorker } from './webhooks/worker.ts';
import { runFeeSchedules } from './routes/fees.ts';
import { pruneGreetings, runGreetings } from './members/greetings.ts';
import { refreshMemberStatuses } from './members/status.ts';
import { applyAgeMoves } from './members/ageMoves.ts';
import { migrate } from './migrate.ts';
import { replayErasures } from './gdpr/service.ts';
import { pruneIdempotencyKeys } from './http/idempotency.ts';

assertDataKey();
await migrate(config.databaseUrl);
const db = createDb(config.databaseUrl);
try {
  await verifyDataKey(db);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const app = await buildApp(db, { logger: true });
// A restored older backup must not bring erased persons back: replay the erasure log before accepting requests.
const replayed = await replayErasures(db, app.log).catch((err: Error) => {
  app.log.fatal(err.message);
  process.exit(1);
});
if (replayed) app.log.warn(`${replayed} erased persons anonymised again after a restore`);
// Public demo: refuse to run demo mode on a real club (it would swallow mail and lock accounts), load the demo
// before accepting requests, and reset it on a schedule.
if (config.demoMode) {
  const org = await db.selectFrom('organization').select('is_demo').executeTakeFirst();
  if (org && !org.is_demo) {
    app.log.fatal('DEMO_MODE=true, but this instance holds a real club. Remove DEMO_MODE to start.');
    process.exit(1);
  }
  const { seedDemo } = await import('./demo/seed.ts');
  const { markDemoReset, resetDemoIfDue } = await import('./demo/reset.ts');
  if (!org) {
    await seedDemo(db);
    await markDemoReset(db);
  }
  // The last reset is stored, so restarts cannot postpone the next one; checked at start and every ten minutes.
  const check = () => void resetDemoIfDue(db, config.demoResetHours).then((done) => done && app.log.info('demo reset'), (err) => app.log.error(err));
  check();
  setInterval(check, 10 * 60_000).unref();
}

await app.listen({ port: config.port, host: '0.0.0.0' });

// Date-driven status changes (future → active, resigned → former, mandate expiry). Hourly is enough: dates, not times, matter.
const refresh = () =>
  Promise.all([
    refreshMemberStatuses(db).then((n) => n && app.log.info(`${n} member statuses updated`)),
    applyAgeMoves(db).then((n) => n && app.log.info(`${n} members moved by age rule`)),
    sweepFiles(db).then((n) => n && app.log.info(`${n} unused files removed`)),
    pruneSignIns(db),
    pruneAgentCalls(db),
    pruneApplications(db),
    pruneIdempotencyKeys(db),
    pruneWebhookDeliveries(db),
    pruneJobs(db),
    runGreetings(db).then((n) => n && app.log.info(`${n} greeting mails sent`)),
    pruneGreetings(db),
    runFeeSchedules(db).then((n) => n && app.log.info(`${n} scheduled fee-run previews created`)),
  ]).catch((err) => app.log.error(err));
await refresh();
setInterval(refresh, 60 * 60 * 1000).unref();
startMailWorker(db, config.publicUrl, (err) => app.log.error(err));
startJobWorker(db, (err) => app.log.error(err));
startWebhookWorker(db, (err) => app.log.error(err));

