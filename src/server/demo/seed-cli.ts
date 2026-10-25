// npm run seed:demo            loads the demo club into an empty instance
// npm run seed:demo -- --reset  wipes a demo instance and loads it again (refused on real data)
import { config } from '../config.ts';
import { createDb } from '../db.ts';
import { migrate } from '../migrate.ts';
import { DEMO_LOGIN, seedDemo } from './seed.ts';

await migrate(config.databaseUrl);
const db = createDb(config.databaseUrl);
try {
  const r = await seedDemo(db, { reset: process.argv.includes('--reset') });
  console.log(`Demo geladen: ${r.members} Mitglieder. Anmelden mit ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
