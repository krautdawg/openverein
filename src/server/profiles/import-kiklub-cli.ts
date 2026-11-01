// Imports KI Klub Werder profiles into this instance once (change public-profiles, slice 3). A dry run shows every
// profile and a code; only `--confirm <code>` writes, and only if nothing changed since.
//
//   KIKLUB_DATABASE_URL=postgres://…/kiklub_copy npm run import:kiklub-profiles -- [--schema public] [--club <host or id>]
//   KIKLUB_DATABASE_URL=… npm run import:kiklub-profiles -- --confirm <code>
//
// Run it against a copy of the KI Klub database, on an instance whose migrations are applied (it applies none).
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { createDb } from '../db.ts';
import { applyImport, planDigest, planImport, readKiKlub } from './importKiKlub.ts';

const { values } = parseArgs({ options: { source: { type: 'string' }, schema: { type: 'string', default: 'public' }, club: { type: 'string' }, confirm: { type: 'string' } } });
// The source address from the environment (it holds a password; the command line ends up in shell history).
const source = process.env.KIKLUB_DATABASE_URL ?? values.source;
if (!source) {
  console.error('KIKLUB_DATABASE_URL (Postgres-Adresse der KI-Klub-Kopie) fehlt.');
  process.exit(2);
}
const db = createDb(config.databaseUrl);
try {
  let q = db.selectFrom('organization').select(['id', 'name', 'hostname']);
  if (values.club) q = q.where((eb) => eb.or([eb('hostname', '=', values.club!), eb(eb.cast('id', 'text'), '=', values.club!)]));
  const orgs = await q.execute();
  if (orgs.length !== 1) throw new Error(values.club ? `Kein Verein „${values.club}“.` : 'Mehrere Vereine: bitte --club <Hostname oder ID> angeben.');
  const org = orgs[0]!;
  const rows = await readKiKlub(source, values.schema);
  if (values.confirm) {
    const { plan, withoutConsent } = await applyImport(db, org.id, rows, values.confirm);
    console.log(`Importiert für ${org.name}: ${plan.filter((r) => r.action === 'create').length} Profile.`);
    if (withoutConsent) console.log(`${withoutConsent} Foto(s) sind gespeichert, aber erst öffentlich, wenn die Person in OpenVerein in „Fotos“ eingewilligt hat.`);
  } else {
    const plan = await planImport(db, org.id, rows);
    console.log(`Probelauf für ${org.name} (nichts geschrieben):`);
    for (const r of plan) {
      const what = r.action === 'create' ? `→ ${r.memberName}: ${r.typeKey}${r.approved ? ', freigegeben' : ', ohne Freigabe'}, Kontakt ${r.visibility}, ${r.links!.length} Link(s)${r.photo ? ', Foto' : ''}` : `übersprungen: ${r.reason}`;
      console.log(`  ${r.email} ${what}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
    }
    console.log(`${plan.filter((r) => r.action === 'create').length} neu, ${plan.filter((r) => r.action === 'skip').length} übersprungen. Schreiben mit: --confirm ${planDigest(plan, rows)}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
