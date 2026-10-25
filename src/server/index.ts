import { buildApp } from './app.ts';
import { config } from './config.ts';
import { assertDataKey } from './crypto.ts';
import { createDb } from './db.ts';
import { sweepFiles } from './files/store.ts';
import { pruneSignIns } from './routes/portal.ts';
import { pruneApplications } from './routes/applications.ts';
import { startMailWorker } from './mail/worker.ts';
import { refreshMemberStatuses } from './members/status.ts';
import { migrate } from './migrate.ts';

assertDataKey();
await migrate(config.databaseUrl);
const db = createDb(config.databaseUrl);
const app = await buildApp(db, { logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });

// Date-driven status changes (future → active, resigned → former, mandate expiry). Hourly is enough: dates, not times, matter.
const refresh = () =>
  Promise.all([
    refreshMemberStatuses(db).then((n) => n && app.log.info(`${n} member statuses updated`)),
    sweepFiles(db).then((n) => n && app.log.info(`${n} unused files removed`)),
    pruneSignIns(db),
    pruneApplications(db),
  ]).catch((err) => app.log.error(err));
await refresh();
setInterval(refresh, 60 * 60 * 1000).unref();
startMailWorker(db, config.publicUrl, (err) => app.log.error(err));

// Public demo: load the demo club into an empty instance, and reset it on a schedule (DEMO_RESET_HOURS, default 24).
if (config.demoMode) {
  const { seedDemo } = await import('./demo/seed.ts');
  const org = await db.selectFrom('organization').select('is_demo').executeTakeFirst();
  if (!org) await seedDemo(db).then(() => app.log.info('demo club loaded'), (err) => app.log.error(err));
  const hours = Number(process.env.DEMO_RESET_HOURS ?? 24);
  if (hours > 0) setInterval(() => void seedDemo(db, { reset: true }).then(() => app.log.info('demo reset'), (err) => app.log.error(err)), hours * 3_600_000).unref();
}
