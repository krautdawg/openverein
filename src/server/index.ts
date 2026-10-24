import { buildApp } from './app.ts';
import { config } from './config.ts';
import { createDb } from './db.ts';
import { migrate } from './migrate.ts';

await migrate(config.databaseUrl);
const app = await buildApp(createDb(config.databaseUrl), { logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });
