import { buildApp } from './app.ts';
import { createDb } from './db.ts';
import { config } from './config.ts';

const db = createDb(config.databaseUrl);
const app = await buildApp(db, { serveWeb: false });
await app.ready();
process.stdout.write(JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
await db.destroy();
