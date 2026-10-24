import { sql } from 'kysely';
import type { Db } from '../db.ts';

/**
 * Moves future → active and resigned → former once their date is reached in each club's time zone.
 * Idempotent; runs at startup and hourly. Every change is audited as the system actor.
 */
export async function refreshMemberStatuses(db: Db) {
  return db.transaction().execute(async (tx) => {
    const changed = await sql<{ id: string; organization_id: string; status: string; old_status: string }>`
      with due as (
        select m.id, m.status as old_status,
          case when m.status = 'future' then 'active' else 'former' end as new_status
        from member m join organization o on o.id = m.organization_id
        where (m.status = 'future' and m.join_date <= (now() at time zone o.time_zone)::date)
           or (m.status = 'resigned' and m.exit_date < (now() at time zone o.time_zone)::date)
        for update of m
      )
      update member m set status = due.new_status, updated_at = now()
      from due where m.id = due.id
      returning m.id, m.organization_id, m.status, due.old_status`.execute(tx);
    for (const r of changed.rows) {
      await tx
        .insertInto('audit_event')
        .values({ organization_id: r.organization_id, actor_user_id: null, actor_label: 'System', action: 'member.status_changed', entity_type: 'member', entity_id: r.id, diff: JSON.stringify({ status: [r.old_status, r.status] }) })
        .execute();
    }
    return changed.rows.length;
  });
}

/** Status a new or reactivated member gets from its join date. */
export const statusForJoin = (joinDate: string, today: string) => (joinDate > today ? 'future' : 'active');
