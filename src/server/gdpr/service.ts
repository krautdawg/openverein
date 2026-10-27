import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { audit } from '../audit.ts';
import { config } from '../config.ts';
import { encrypt } from '../crypto.ts';
import type { Db } from '../db.ts';
import { deleteChain, deletionBlocker, lockChain } from '../files/chain.ts';
import { emailHash } from '../mail/worker.ts';
import { purgeTenant, recordPurgeFile } from '../tenantPurge.ts';
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
  const payerOf = await tx.selectFrom('household').select('name').where('payer_person_id', '=', personId).execute();
  for (const h of payerOf) out.push(`Zahlende Person des Haushalts „${h.name}“: wähle dort zuerst eine andere.`);
  // The address is needed for the receipt.
  const unreceipted = await tx.selectFrom('donation').select(sql<number>`count(*)::int`.as('n')).where('person_id', '=', personId).where('voided_at', 'is', null)
    .where((eb) => eb.not(eb.exists(eb.selectFrom('donation_receipt_item').select('donation_id').whereRef('donation_receipt_item.donation_id', '=', 'donation.id').where('live', '=', true)))).executeTakeFirstOrThrow();
  if (unreceipted.n) out.push(`${unreceipted.n} Spende${unreceipted.n === 1 ? ' ist' : 'n sind'} noch nicht bestätigt.`);
  return out;
}

/**
 * Removes a person's personal data. Issued invoices, receipts and the journal keep their own snapshots until their
 * retention ends; the person row stays with an opaque id. Files under retention or legal hold stay as well.
 */
/** Erasures and the end of a full export of one club never overlap (see runFullExport). */
/** True when more erasures are committed than an export snapshot contained (call under lockErasures). */
export async function erasuresSince(tx: Db, organizationId: string, inSnapshot: number) {
  const now = await tx.selectFrom('erasure_log').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', organizationId).executeTakeFirstOrThrow();
  return now.n > inSnapshot;
}

export const lockErasures = (tx: Db, organizationId: string) => sql`select pg_advisory_xact_lock(hashtext(${`openverein:erasure:${organizationId}`}))`.execute(tx);

export async function anonymise(tx: Db, organizationId: string, personId: string) {
  await lockErasures(tx, organizationId);
  const p = await tx.selectFrom('person').select('email').where('id', '=', personId).where('organization_id', '=', organizationId).forUpdate().executeTakeFirstOrThrow();
  const today = await orgToday(tx, organizationId);
  await tx
    .updateTable('person')
    .set({ kind: 'natural', first_name: null, last_name: ANONYMOUS, company_name: null, birth_date: null, email: null, phone: null, street: null, postal_code: null, city: null, note: null, custom: sql`'{}'::jsonb`, einvoice_format: 'none', buyer_reference: null, gender: null, einvoice_address: null, vat_id: null, preferred_channel: 'none', anonymised_at: new Date(), updated_at: new Date() })
    .where('id', '=', personId)
    .execute();
  // The person's agent tokens (keyed by the address) go with the address: trigger member_tokens_follow_email.
  // Notes about the person go entirely (before member files, which an entry may point to).
  await tx.deleteFrom('contact_log').where('person_id', '=', personId).execute();
  // Expense claims stay as vouchers, but the payout details are no longer needed.
  await tx.updateTable('expense_claim').set({ account_holder: ANONYMOUS, iban_encrypted: encrypt('') }).where('person_id', '=', personId).execute();
  const members = (await tx.selectFrom('member').select('id').where('person_id', '=', personId).execute()).map((m) => m.id);
  const fileIds: string[] = [];
  // Tasks about the person ("Müller wegen Rückstand anrufen") go with their audit trail; honours go too.
  // Issued offers stay, like invoices: they are business letters to keep (§ 147 AO), frozen by trigger. Drafts were
  // never sent, so nothing keeps them.
  const drafts = (await tx.selectFrom('offer').select('id').where('person_id', '=', personId).where('status', '=', 'draft').execute()).map((o) => o.id);
  if (drafts.length) {
    await tx.deleteFrom('offer_line').where('offer_id', 'in', drafts).execute();
    await tx.deleteFrom('offer').where('id', 'in', drafts).execute();
  }
  const taskIds = members.length ? (await tx.deleteFrom('task').where('member_id', 'in', members).returning('id').execute()).map((t) => t.id) : [];
  if (members.length) await tx.deleteFrom('honour').where('member_id', 'in', members).execute();
  if (members.length) {
    await tx.updateTable('member').set({ exit_reason: null }).where('id', 'in', members).execute();
    // Deletable member files go; vouchers in retention and files on hold stay.
    const heads = await tx.selectFrom('file').select('id').where('member_id', 'in', members).where('superseded_at', 'is', null).execute();
    for (const h of heads) {
      const chain = await lockChain(tx, h.id);
      if (chain && !deletionBlocker(chain, today)) {
        fileIds.push(...chain.map((v) => v.id));
        await deleteChain(tx, chain);
      }
    }
    // The application trigger allows exactly this scrub once a decision was made.
    await tx.updateTable('application').set({ payload: '{}', iban_encrypted: null, iban_last4: null, reason: null }).where('member_id', 'in', members).where('status', '<>', 'new').execute();
  }
  await tx.updateTable('change_request').set({ old_value: null, new_value: '', requested_by_email: '', reason: null }).where('person_id', '=', personId).execute();
  await tx.updateTable('donation').set({ note: null }).where('person_id', '=', personId).where('note', 'is not', null).execute();
  await tx.updateTable('collection_item').set({ amended_from_iban_encrypted: null }).where('person_id', '=', personId).execute();
  // A random hash, so bank matching no longer suggests this person for that IBAN.
  for (const m of await tx.selectFrom('sepa_mandate').select('id').where('person_id', '=', personId).execute()) {
    await tx.updateTable('sepa_mandate').set({ account_holder: ANONYMOUS, iban_encrypted: encrypt(''), iban_hash: randomBytes(32).toString('hex'), amended_from_iban_encrypted: null, revoke_reason: null, updated_at: new Date() }).where('id', '=', m.id).execute();
  }
  await tx.updateTable('delivery').set({ status: 'skipped', error: null }).where('person_id', '=', personId).where('status', 'in', ['queued', 'sending']).execute();
  await tx.updateTable('delivery').set({ email: '', error: null }).where('person_id', '=', personId).execute();
  await tx.deleteFrom('consent').where('person_id', '=', personId).execute();
  if (p.email) {
    await tx.deleteFrom('portal_session').where('organization_id', '=', organizationId).where(sql`lower(email)`, '=', p.email.toLowerCase()).execute();
    await tx.deleteFrom('login_code').where('organization_id', '=', organizationId).where('email_hash', '=', emailHash(p.email)).execute();
  }
  // Audit entries keep what happened and when, not the values (the trigger allows exactly this inside the scrub).
  await sql`select set_config('ov.scrub', 'on', true)`.execute(tx);
  await tx.updateTable('audit_event').set({ diff: null }).where('organization_id', '=', organizationId).where('entity_id', 'in', [personId, ...members, ...fileIds, ...taskIds]).where('diff', 'is not', null).execute();
  await sql`select set_config('ov.scrub', 'off', true)`.execute(tx);
  // Full exports contain the person; they are recreated on demand, never kept past an erasure.
  await tx.deleteFrom('file').where('organization_id', '=', organizationId).where('purpose', '=', 'export').execute();
  // Stored API responses may name the person. The keys stay, so a retry is still recognised as done, not booked twice.
  await tx.updateTable('idempotency_key').set({ response: null }).where('organization_id', '=', organizationId).where('response', 'is not', null).execute();
  await tx.insertInto('erasure_log').values({ organization_id: organizationId, person_id: personId }).execute();
}

/** Appends the erasure outside the database (after commit), so restoring an older backup can replay it. */
export async function recordErasureFile(organizationId: string, personId: string) {
  await mkdir(config.filesDir, { recursive: true });
  await appendFile(erasureFile(), JSON.stringify({ o: organizationId, p: personId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Run at start-up before requests. The file is the copy that survives a database restore: first every erasure the
 * database knows but the file lacks is appended (a failed append after commit), then every erasure in the file whose
 * person is back is anonymised again. Unreadable lines are skipped and reported.
 */
export async function replayErasures(db: Db, log: { warn: (msg: string) => void } = console) {
  let text = '';
  try {
    text = await readFile(erasureFile(), 'utf8');
  } catch {
    // no file yet
  }
  const seen = new Set<string>();
  const entries: { o: string; p: string }[] = [];
  const purged = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const { o, p, purge } = JSON.parse(line) as { o: unknown; p: unknown; purge?: unknown };
      // A purge intent, or its withdrawal after a rollback (the later line wins).
      if (typeof purge === 'boolean' && typeof o === 'string' && UUID.test(o)) {
        if (purge) purged.add(o);
        else purged.delete(o);
        return;
      }
      if (typeof o !== 'string' || typeof p !== 'string' || !UUID.test(o) || !UUID.test(p)) throw new Error('shape');
      seen.add(p);
      entries.push({ o, p });
    } catch {
      log.warn(`erasure log line ${i + 1} unreadable, skipped`);
    }
  });
  for (const r of await db.selectFrom('erasure_log').select(['organization_id', 'person_id']).execute()) {
    if (seen.has(r.person_id)) continue;
    await recordErasureFile(r.organization_id, r.person_id);
    seen.add(r.person_id);
  }
  // Deleted clubs (managed hosting): the database record wins if the file append failed after the commit.
  for (const r of await db.selectFrom('operator_event').select('organization_id').where('action', '=', 'tenant.purged').execute()) {
    if (purged.has(r.organization_id)) continue;
    await recordPurgeFile(r.organization_id);
    purged.add(r.organization_id);
  }
  let n = 0;
  // Every failure is collected; the start stops afterwards, so restored personal data is never served.
  const failed: string[] = [];
  for (const o of purged) {
    if (!(await db.selectFrom('organization').select('id').where('id', '=', o).executeTakeFirst())) continue;
    try {
      await purgeTenant(db, o);
      log.warn(`club ${o} deleted again after a restore`);
      n++;
    } catch (err) {
      log.warn(`Deletion of club ${o} could not be repeated after the restore; repeat it by hand: ${String(err)}`);
      failed.push(`club ${o}`);
    }
  }
  for (const { o, p } of entries) {
    if (purged.has(o)) continue;
    // One erasure that cannot be repeated must not keep the server from starting; it is logged for the operator.
    const again = await db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('person').select('anonymised_at').where('id', '=', p).where('organization_id', '=', o).forUpdate().executeTakeFirst();
      if (!row || row.anonymised_at) return false;
      await anonymise(tx, o, p);
      await audit(tx, o, null, { action: 'person.anonymised_again', entityType: 'person', entityId: p });
      return true;
    }).catch((err: unknown) => {
      log.warn(`Erasure of person ${p} (organization ${o}) could not be repeated after the restore; repeat it by hand: ${String(err)}`);
      failed.push(`person ${p}`);
      return false;
    });
    if (again) n++;
  }
  if (failed.length) throw new Error(`Nach dem Zurückspielen ließen sich ${failed.length} Löschungen nicht wiederholen (${failed.join(', ')}). Der Server startet erst, wenn sie nachgeholt sind (siehe docs/operations.md).`);
  return n;
}
