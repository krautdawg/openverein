import type { Db } from './db.ts';
import type { AppUser } from './db.ts';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  diff?: unknown;
}

/** Writes one audit event; call it inside the same transaction as the change. */
export async function audit(db: Db, organizationId: string, actor: Pick<AppUser, 'id' | 'name'> | null, e: AuditInput) {
  await db
    .insertInto('audit_event')
    .values({
      organization_id: organizationId,
      actor_user_id: actor?.id ?? null,
      actor_label: actor?.name ?? 'System',
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      diff: e.diff === undefined ? null : JSON.stringify(e.diff),
    })
    .execute();
}
