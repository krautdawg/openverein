import type { Db } from './db.ts';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  diff?: unknown;
}

export interface AuditActor {
  userId: string | null;
  name: string;
  kind?: 'user' | 'token';
}

/** Writes one audit event; call it inside the same transaction as the change. */
export async function audit(db: Db, organizationId: string, actor: AuditActor | null, e: AuditInput) {
  await db
    .insertInto('audit_event')
    .values({
      organization_id: organizationId,
      actor_user_id: actor?.userId ?? null,
      actor_label: actor ? (actor.kind === 'token' ? `API: ${actor.name}` : actor.name) : 'System',
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      diff: e.diff === undefined ? null : JSON.stringify(e.diff),
    })
    .execute();
}

/** Field-level before/after for the keys that changed. */
export function diffOf<T extends Record<string, unknown>>(before: T, after: Partial<T>, mask: Set<string> = new Set()) {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(after)) {
    if (v === undefined || before[k] === v) continue;
    out[k] = mask.has(k) ? ['•••', '•••'] : [before[k] ?? null, v];
  }
  return out;
}
