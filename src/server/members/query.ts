import { sql, type ExpressionBuilder, type Selectable } from 'kysely';
import type { Database, Db, MemberTable, PersonTable } from '../db.ts';
import { todayIn } from '../../shared/dates.ts';
import type { MemberDetail, MemberListItem } from '../../shared/members.ts';
import { notFound } from '../http/problem.ts';
import { restrictedFields, scopeOf, type Actor } from '../policy.ts';

export async function orgToday(db: Db, organizationId: string) {
  const org = await db.selectFrom('organization').select('time_zone').where('id', '=', organizationId).executeTakeFirstOrThrow();
  return todayIn(org.time_zone);
}

/**
 * Division scope as SQL. Reading: a current membership in a scoped group, or one that ended within
 * the last 12 months. Writing: a current membership only.
 */
export function scopePredicate(groups: string[], today: string, mode: 'read' | 'write') {
  const window = mode === 'read' ? sql`${today}::date - interval '12 months'` : sql`${today}::date`;
  return sql<boolean>`exists (
    select 1 from group_membership gm
    where gm.member_id = member.id and gm.group_id = any(${groups}::uuid[])
      and gm.valid_from <= ${today}::date and (gm.valid_to is null or gm.valid_to >= ${window}))`;
}

export function applyScope(actor: Actor, today: string, mode: 'read' | 'write') {
  const groups = scopeOf(actor, 'members', mode);
  return (eb: ExpressionBuilder<Database, 'member'>) => (groups === null ? eb.val(true) : scopePredicate(groups, today, mode));
}

export const memberColumns = [
  'member.id',
  'member.person_id',
  'member.membership_number',
  'member.status',
  'member.application_date',
  'member.join_date',
  'member.notice_date',
  'member.exit_date',
  'member.exit_reason',
  'person.kind',
  'person.first_name',
  'person.last_name',
  'person.company_name',
  'person.birth_date',
  'person.email',
  'person.phone',
  'person.street',
  'person.postal_code',
  'person.city',
  'person.country',
  'person.preferred_channel',
  'person.note',
] as const;

type Row = Pick<Selectable<MemberTable>, 'id' | 'person_id' | 'membership_number' | 'status' | 'application_date' | 'join_date' | 'notice_date' | 'exit_date' | 'exit_reason'> &
  Pick<Selectable<PersonTable>, 'kind' | 'first_name' | 'last_name' | 'company_name' | 'birth_date' | 'email' | 'phone' | 'street' | 'postal_code' | 'city' | 'country' | 'preferred_channel' | 'note'>;

/** Current group badges for a set of members. */
export async function currentGroups(db: Db, memberIds: string[], today: string) {
  if (memberIds.length === 0) return new Map<string, MemberListItem['groups']>();
  const rows = await db
    .selectFrom('group_membership')
    .innerJoin('club_group', 'club_group.id', 'group_membership.group_id')
    .select(['group_membership.member_id', 'club_group.id', 'club_group.name', 'club_group.short_code', 'club_group.color'])
    .where('group_membership.member_id', 'in', memberIds)
    .where('group_membership.valid_from', '<=', today)
    .where((eb) => eb.or([eb('group_membership.valid_to', 'is', null), eb('group_membership.valid_to', '>=', today)]))
    .where('club_group.archived_at', 'is', null)
    .orderBy('club_group.name')
    .execute();
  const map = new Map<string, MemberListItem['groups']>();
  for (const r of rows) {
    const list = map.get(r.member_id) ?? [];
    list.push({ id: r.id, name: r.name, shortCode: r.short_code, color: r.color });
    map.set(r.member_id, list);
  }
  return map;
}

/** Maps a row to the list shape, leaving out fields the actor's roles restrict. */
export function toListItem(r: Row, groups: MemberListItem['groups'], hidden: Set<string>): MemberListItem {
  return {
    id: r.id,
    personId: r.person_id,
    membershipNumber: r.membership_number,
    status: r.status,
    kind: r.kind,
    firstName: r.first_name,
    lastName: r.last_name,
    companyName: r.company_name,
    ...(hidden.has('email') ? {} : { email: r.email }),
    city: r.city,
    joinDate: r.join_date,
    exitDate: r.exit_date,
    groups,
  };
}

/** Loads one member within the actor's scope; out-of-scope members do not exist for the actor. */
export async function loadMemberRow(db: Db, actor: Actor, id: string, mode: 'read' | 'write' = 'read') {
  const today = await orgToday(db, actor.organizationId);
  const row = await db
    .selectFrom('member')
    .innerJoin('person', 'person.id', 'member.person_id')
    .select(memberColumns)
    .where('member.id', '=', id)
    .where('member.organization_id', '=', actor.organizationId)
    .where(applyScope(actor, today, mode))
    .executeTakeFirst();
  if (!row) throw notFound('Mitglied');
  return { row, today };
}

export async function memberDetail(db: Db, actor: Actor, id: string, extraWarnings: string[] = []): Promise<MemberDetail> {
  const { row, today } = await loadMemberRow(db, actor, id);
  const hidden = restrictedFields(actor);
  const groups = (await currentGroups(db, [row.id], today)).get(row.id) ?? [];
  const memberships = await db
    .selectFrom('group_membership')
    .innerJoin('club_group', 'club_group.id', 'group_membership.group_id')
    .select(['group_membership.id', 'group_membership.group_id', 'club_group.name', 'club_group.color', 'group_membership.valid_from', 'group_membership.valid_to'])
    .where('group_membership.member_id', '=', row.id)
    .orderBy('group_membership.valid_from')
    .execute();
  const timeline = await db
    .selectFrom('audit_event')
    .select(['at', 'action', 'actor_label', 'diff'])
    .where('organization_id', '=', actor.organizationId)
    .where((eb) => eb.or([eb.and([eb('entity_type', '=', 'member'), eb('entity_id', '=', row.id)]), eb.and([eb('entity_type', '=', 'person'), eb('entity_id', '=', row.person_id)])]))
    .orderBy('at', 'desc')
    .limit(50)
    .execute();
  const warnings = [...extraWarnings];
  if (!row.email && !row.street && !row.phone) warnings.push('Keine Kontaktdaten erfasst.');
  if (row.preferred_channel === 'email' && !row.email) warnings.push('Bevorzugt E-Mail, aber keine E-Mail-Adresse hinterlegt.');
  if (row.preferred_channel === 'letter' && (!row.street || !row.postal_code || !row.city)) warnings.push('Bevorzugt Brief, aber die Anschrift ist unvollständig.');

  const pick = <T>(field: string, value: T) => (hidden.has(field) ? {} : { [toCamel(field)]: value });
  return {
    ...toListItem(row, groups, hidden),
    ...pick('birth_date', row.birth_date),
    ...pick('phone', row.phone),
    ...pick('note', row.note),
    street: row.street,
    postalCode: row.postal_code,
    country: row.country,
    preferredChannel: row.preferred_channel,
    applicationDate: row.application_date,
    noticeDate: row.notice_date,
    exitReason: row.exit_reason,
    memberships: memberships.map((m) => ({ id: m.id, groupId: m.group_id, groupName: m.name, color: m.color, validFrom: m.valid_from, validTo: m.valid_to })),
    timeline: timeline.map((t) => ({ at: t.at.toISOString(), action: t.action, actor: t.actor_label, diff: maskDiff(t.diff, hidden) })),
    warnings,
    restricted: [...hidden],
  };
}

const toCamel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** Audit diffs keep raw values; viewers without the field right see them masked. */
export function maskDiff(diff: unknown, hidden: Set<string>) {
  if (!diff || typeof diff !== 'object') return diff;
  return Object.fromEntries(
    Object.entries(diff as Record<string, unknown>).map(([k, v]) => [k, hidden.has(k) || hidden.has(k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())) ? ['•••', '•••'] : v]),
  );
}
