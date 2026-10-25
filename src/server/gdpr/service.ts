import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { config } from '../config.ts';
import { encrypt } from '../crypto.ts';
import type { Db } from '../db.ts';
import { deleteChain, deletionBlocker, lockChain } from '../files/chain.ts';
import { emailHash } from '../mail/worker.ts';
import { orgToday } from '../members/query.ts';

export const ANONYMOUS = 'Anonymisiert';
const erasureFile = () => join(config.filesDir, 'erasure-log.jsonl');

/** Reasons that keep a person from being anonymised today; empty when it may go ahead. */
export async function anonymiseBlockers(tx: Db, organizationId: string, personId: string) {
  const out: string[] = [];
  const p = await tx.selectFrom('person').select(['legal_hold_reason', 'anonymised_at']).where('id', '=', personId).where('organization_id', '=', organizationId).executeTakeFirst();
  if (!p) return ['Person nicht gefunden.'];
  if (p.anonymised_at) return ['Schon anonymisiert.'];
  if (p.legal_hold_reason) out.push(`Löschsperre: ${p.legal_hold_reason}`);
  const live = await tx.selectFrom('member').select('membership_number').where('person_id', '=', personId).where('status', 'in', ['applicant', 'future', 'active', 'resigned']).execute();
  for (const m of live) out.push(`Mitgliedschaft ${m.membership_number} ist noch nicht beendet.`);
  const open = await tx.selectFrom('invoice').select(['number', 'status']).where('recipient_person_id', '=', personId).where('status', 'in', ['draft', 'open', 'partially_paid']).execute();
  for (const i of open) out.push(i.status === 'draft' ? 'Ein Rechnungsentwurf ist noch offen.' : `Rechnung ${i.number} ist noch offen.`);
  const today = await orgToday(tx, organizationId);
  // SEPA mandates are kept 14 months after the last collection (proof for refund claims).
  const keep = await sql<{ reference: string; until: string }>`
    select reference, (coalesce(last_collected_on, revoked_on, signed_on) + interval '14 months')::date::text as until from sepa_mandate
    where person_id = ${personId} and (status in ('active', 'pending_evidence') or coalesce(last_collected_on, revoked_on, signed_on) + interval '14 months' >= ${today}::date)`.execute(tx);
  for (const m of keep.rows) out.push(`SEPA-Mandat ${m.reference} muss bis ${m.until.split('-').reverse().join('.')} aufbewahrt werden.`);
  return out;
}

/**
 * Removes a person's personal data. Issued invoices, receipts and the journal keep their own snapshots until their
 * retention ends; the person row stays with an opaque id. Files under retention or legal hold stay as well.
 */
export async function anonymise(tx: Db, organizationId: string, personId: string) {
  const p = await tx.selectFrom('person').select('email').where('id', '=', personId).where('organization_id', '=', organizationId).forUpdate().executeTakeFirstOrThrow();
  const today = await orgToday(tx, organizationId);
  await tx
    .updateTable('person')
    .set({ kind: 'natural', first_name: null, last_name: ANONYMOUS, company_name: null, birth_date: null, email: null, phone: null, street: null, postal_code: null, city: null, note: null, preferred_channel: 'none', anonymised_at: new Date(), updated_at: new Date() })
    .where('id', '=', personId)
    .execute();
  const members = (await tx.selectFrom('member').select('id').where('person_id', '=', personId).execute()).map((m) => m.id);
  if (members.length) {
    await tx.updateTable('member').set({ exit_reason: null }).where('id', 'in', members).execute();
    // Deletable member files go; vouchers in retention and files on hold stay.
    const heads = await tx.selectFrom('file').select('id').where('member_id', 'in', members).where('superseded_at', 'is', null).execute();
    for (const h of heads) {
      const chain = await lockChain(tx, h.id);
      if (chain && !deletionBlocker(chain, today)) await deleteChain(tx, chain);
    }
    await tx.updateTable('change_request').set({ old_value: null, new_value: '' }).where('person_id', '=', personId).execute();
    // The application trigger allows exactly this scrub once a decision was made.
    await tx.updateTable('application').set({ payload: '{}', iban_encrypted: null, iban_last4: null }).where('member_id', 'in', members).where('status', '<>', 'new').execute();
  }
  await tx.updateTable('sepa_mandate').set({ account_holder: ANONYMOUS, iban_encrypted: encrypt(''), amended_from_iban_encrypted: null, revoke_reason: null, updated_at: new Date() }).where('person_id', '=', personId).execute();
  await tx.updateTable('delivery').set({ email: '' }).where('person_id', '=', personId).execute();
  await tx.deleteFrom('consent').where('person_id', '=', personId).execute();
  if (p.email) {
    await tx.deleteFrom('portal_session').where('organization_id', '=', organizationId).where(sql`lower(email)`, '=', p.email.toLowerCase()).execute();
    await tx.deleteFrom('login_code').where('organization_id', '=', organizationId).where('email_hash', '=', emailHash(p.email)).execute();
  }
  await tx.insertInto('erasure_log').values({ organization_id: organizationId, person_id: personId }).execute();
}

/** Appends the erasure outside the database (after commit), so restoring an older backup can replay it. */
export async function recordErasureFile(organizationId: string, personId: string) {
  await mkdir(config.filesDir, { recursive: true });
  await appendFile(erasureFile(), JSON.stringify({ o: organizationId, p: personId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}

/** Run at start-up before requests: anonymises persons from the erasure file that a restored backup brought back. */
export async function replayErasures(db: Db) {
  let text: string;
  try {
    text = await readFile(erasureFile(), 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const { o, p } = JSON.parse(line) as { o: string; p: string };
    const again = await db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('person').select('anonymised_at').where('id', '=', p).where('organization_id', '=', o).executeTakeFirst();
      if (!row || row.anonymised_at) return false;
      await anonymise(tx, o, p);
      return true;
    });
    if (again) n++;
  }
  return n;
}
