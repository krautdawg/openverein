import { sql } from 'kysely';
import type { Db } from '../db.ts';

interface Due { membership_id: string; member_id: string; organization_id: string; group_id: string; next_group_id: string; move_on: string; today: string }

/** Open memberships in groups with an age rule, with the date the rule moves them (birthday or 1 January). */
const dueMoves = (db: Db, organizationId: string | null, until: string | null) => sql<Due>`
  select * from (
    select gm.id as membership_id, gm.member_id, gm.organization_id, g.id as group_id, g.next_group_id, gm.valid_from,
      (case g.next_group_on
        when 'birthday' then (p.birth_date + make_interval(years => g.next_group_age))::date
        else make_date(extract(year from p.birth_date)::int + g.next_group_age, 1, 1)
      end)::text as move_on,
      ((now() at time zone o.time_zone)::date)::text as today
    from group_membership gm
    join club_group g on g.id = gm.group_id and g.next_group_id is not null and g.archived_at is null
    join member m on m.id = gm.member_id and m.status in ('active', 'future', 'resigned')
    join person p on p.id = m.person_id and p.birth_date is not null
    join organization o on o.id = gm.organization_id
    where gm.valid_to is null and (${organizationId}::uuid is null or gm.organization_id = ${organizationId}::uuid)
  ) d
  -- Someone added to the group after reaching the age was put there on purpose: no move.
  where d.move_on::date > d.valid_from and d.move_on::date <= coalesce(${until}::date, d.today::date)
  order by d.move_on, d.member_id`.execute(db);

/** Upcoming moves for the preview (overdue ones included). */
export async function upcomingAgeMoves(db: Db, organizationId: string, until: string) {
  return (await dueMoves(db, organizationId, until)).rows;
}

/**
 * Moves members whose rule date has come: the old membership ends the day before today, the new one starts today
 * (history is not backdated when the job ran late or the rule is new). Runs with the hourly status refresh.
 */
export async function applyAgeMoves(db: Db) {
  return db.transaction().execute(async (tx) => {
    let moved = 0;
    for (const d of (await dueMoves(tx, null, null)).rows) {
      await tx.updateTable('group_membership').set({ valid_to: sql<string>`${d.today}::date - 1` }).where('id', '=', d.membership_id).where('valid_to', 'is', null).execute();
      const already = await tx.selectFrom('group_membership').select('id').where('member_id', '=', d.member_id).where('group_id', '=', d.next_group_id).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', d.today)])).executeTakeFirst();
      if (!already) await tx.insertInto('group_membership').values({ organization_id: d.organization_id, member_id: d.member_id, group_id: d.next_group_id, valid_from: d.today }).execute();
      await tx.insertInto('audit_event').values({ organization_id: d.organization_id, actor_user_id: null, actor_label: 'System', action: 'member.group_moved_by_age', entity_type: 'member', entity_id: d.member_id, diff: JSON.stringify({ from: [d.group_id, null], to: [null, d.next_group_id], on: [null, d.today] }) }).execute();
      moved++;
    }
    return moved;
  });
}
