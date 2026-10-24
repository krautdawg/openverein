import { buildApp } from './app.ts';
import { config } from './config.ts';
import { assertDataKey } from './crypto.ts';
import { createDb } from './db.ts';
import { sweepFiles } from './files/store.ts';
import { pruneSignIns } from './routes/portal.ts';
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
  ]).catch((err) => app.log.error(err));
await refresh();
setInterval(refresh, 60 * 60 * 1000).unref();
startMailWorker(db, config.publicUrl, (err) => app.log.error(err));
