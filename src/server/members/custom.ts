import { sql } from 'kysely';
import { checkCustomValue, type CustomValue } from '../../shared/customFields.ts';
import { audit } from '../audit.ts';
import type { Db } from '../db.ts';
import { Problem } from '../http/problem.ts';
import { scopeOf, type Actor } from '../policy.ts';

/** Sensitive fields are for club-wide readers only (group-scoped trainers do not see them). */
export const seesSensitive = (actor: Actor) => scopeOf(actor, 'members', 'read') === null;

export async function fieldsFor(db: Db, actor: Actor, opts: { archived?: boolean; lock?: boolean } = {}) {
  let q = db.selectFrom('custom_field').selectAll().where('organization_id', '=', actor.organizationId);
  if (!opts.archived) q = q.where('archived_at', 'is', null);
  if (!seesSensitive(actor)) q = q.where('sensitive', '=', false);
  // A definition change (type, options) waits for writes in flight, and the other way round.
  if (opts.lock) q = q.forShare();
  return q.orderBy('position').orderBy('label').execute();
}

/** Keys (`custom.<key>`) of fields whose values this user may see in diffs. */
export async function visibleDiffKeys(db: Db, actor: Actor) {
  return new Set((await fieldsFor(db, actor)).filter((f) => !f.sensitive).map((f) => `custom.${f.key}`));
}

/** The visible values of one person, by field id. */
export function visibleValues(custom: Record<string, unknown> | null | undefined, fields: { id: string }[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (custom && custom[f.id] !== undefined && custom[f.id] !== null) out[f.id] = custom[f.id];
  return out;
}

/**
 * Validates and writes custom values for a person. On create every required field must be set; on patch only the
 * given fields change. Fields the user may not see cannot be written.
 */
export async function writeCustom(tx: Db, actor: Actor, personId: string, input: Record<string, unknown> | undefined, mode: 'create' | 'patch') {
  const fields = await fieldsFor(tx, actor, { lock: true });
  const before = input && Object.keys(input).length ? ((await tx.selectFrom('person').select('custom').where('id', '=', personId).forUpdate().executeTakeFirstOrThrow()).custom ?? {}) : {};
  // An unticked checkbox that was never set stays unset; otherwise compare as stored.
  const same = (type: string, a: unknown, b: unknown) => JSON.stringify(type === 'checkbox' && !a ? null : (a ?? null)) === JSON.stringify(type === 'checkbox' && !b ? null : (b ?? null));
  const next: Record<string, CustomValue> = {};
  const errors: { field: string; message: string }[] = [];
  for (const [id, v] of Object.entries(input ?? {})) {
    const f = fields.find((x) => x.id === id);
    if (!f) {
      errors.push({ field: `custom.${id}`, message: 'Unbekanntes oder archiviertes Feld.' });
      continue;
    }
    // Unchanged values are neither re-validated nor written: a field made required later does not block other edits.
    if (mode === 'patch' && same(f.type, before[id], typeof v === 'string' ? v.trim() || null : v)) continue;
    const r = checkCustomValue(f, v);
    if (r.ok) next[id] = r.value;
    else errors.push({ field: `custom.${id}`, message: r.message });
  }
  if (mode === 'create') for (const f of fields) if (f.required && f.type !== 'checkbox' && next[f.id] === undefined) errors.push({ field: `custom.${f.id}`, message: `${f.label} ist ein Pflichtfeld.` });
  if (errors.length) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors });
  if (!Object.keys(next).length) return;
  const set = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null));
  const drop = Object.entries(next).filter(([, v]) => v === null).map(([k]) => k);
  await tx.updateTable('person').set({ custom: sql`(custom - ${drop}::text[]) || ${JSON.stringify(set)}::jsonb`, updated_at: new Date() }).where('id', '=', personId).execute();
  // Sensitive values stay out of the audit log; it records that they changed.
  const diff = Object.fromEntries(Object.entries(next).map(([id, v]) => {
    const f = fields.find((x) => x.id === id)!;
    return [`custom.${f.key}`, f.sensitive ? ['***', '***'] : [before[id] ?? null, v]];
  }));
  if (mode === 'patch') await audit(tx, actor.organizationId, actor, { action: 'person.custom_updated', entityType: 'person', entityId: personId, diff });
}
