import { buildApp } from './app.ts';
import { config } from './config.ts';
import { createDb } from './db.ts';
import { migrate } from './migrate.ts';

import { refreshMemberStatuses } from './members/status.ts';

await migrate(config.databaseUrl);
const db = createDb(config.databaseUrl);
const app = await buildApp(db, { logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });

// Date-driven status changes (future → active, resigned → former). Hourly is enough: dates, not times, matter.
const refresh = () => refreshMemberStatuses(db).then((n) => n && app.log.info(`${n} member statuses updated`), (err) => app.log.error(err));
await refresh();
setInterval(refresh, 60 * 60 * 1000).unref();
