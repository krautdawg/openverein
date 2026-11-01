// Imports KI Klub Werder profiles into this instance (change public-profiles, slice 3). Dry run unless --confirm.
//
//   npm run import:kiklub-profiles -- --source postgres://…/kiklub_copy [--schema public] [--club <hostname or id>]
//   npm run import:kiklub-profiles -- --source … --confirm
//
// Run it against a copy of the KI Klub database first. Matching is by member e-mail address.
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { createDb } from '../db.ts';
import { migrate } from '../migrate.ts';
import { applyImport, planImport, readKiKlub } from './importKiKlub.ts';

const { values } = parseArgs({ options: { source: { type: 'string' }, schema: { type: 'string', default: 'public' }, club: { type: 'string' }, confirm: { type: 'boolean', default: false } } });
if (!values.source) {
  console.error('--source <Postgres-Adresse der KI-Klub-Datenbank> fehlt.');
  process.exit(2);
}
await migrate(config.databaseUrl);
const db = createDb(config.databaseUrl);
try {
  let q = db.selectFrom('organization').select(['id', 'name', 'hostname']);
  if (values.club) q = q.where((eb) => eb.or([eb('hostname', '=', values.club!), eb(eb.cast('id', 'text'), '=', values.club!)]));
  const orgs = await q.execute();
  if (orgs.length !== 1) throw new Error(values.club ? `Kein Verein „${values.club}“.` : 'Mehrere Vereine: bitte --club <Hostname oder ID> angeben.');
  const org = orgs[0]!;
  const source = await readKiKlub(values.source, values.schema);
  const result = values.confirm ? await applyImport(db, org.id, source) : { plan: await planImport(db, org.id, source), withoutConsent: 0 };
  const plan = result.plan;
  const count = (a: string) => plan.filter((r) => r.action === a).length;
  console.log(`${values.confirm ? 'Importiert' : 'Probelauf (nichts geschrieben)'} für ${org.name}: ${count('create')} neu, ${count('update')} aktualisiert, ${count('skip')} übersprungen.`);
  for (const r of plan) {
    if (r.action === 'skip' || r.notes.length) console.log(`  ${r.action.padEnd(6)} ${r.email}${r.reason ? `: ${r.reason}` : ''}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
  }
  if (!values.confirm) console.log('Mit --confirm schreiben.');
  else if (result.withoutConsent) console.log(`${result.withoutConsent} Foto(s) sind gespeichert, aber erst öffentlich, wenn die Person in OpenVerein in „Fotos“ eingewilligt hat.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
