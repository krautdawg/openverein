import type { z } from 'zod';
import type { bulkBody } from '../../shared/members.ts';
import { audit } from '../audit.ts';
import type { Db } from '../db.ts';
import { forbidden, Problem } from '../http/problem.ts';
import { scopeOf, type Actor } from '../policy.ts';
import { orgToday } from './query.ts';

/** Above this many members a bulk action runs as a job. */
export const BULK_INLINE_MAX = 100;

/** The group must exist in the organisation and, for scoped actors, be one of their groups. */
export async function assertGroup(db: Db, actor: Actor, groupId: string) {
  const group = await db.selectFrom('club_group').select(['id', 'archived_at']).where('id', '=', groupId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
  if (!group) throw new Problem(404, 'not-found', 'Gruppe nicht gefunden.');
  if (group.archived_at) throw new Problem(409, 'archived', 'Die Gruppe ist archiviert.');
  const scope = scopeOf(actor, 'members', 'write');
  if (scope !== null && !scope.includes(groupId)) throw forbidden('members:write (Gruppe außerhalb Deines Bereichs)');
}

/** Adds members to or ends their membership in a group; members outside the actor's scope are skipped with a reason. */
export async function memberBulk(db: Db, actor: Actor, input: z.infer<typeof bulkBody>, hooks: { before?: (tx: Db) => Promise<void>; after?: (tx: Db, result: { succeeded: number; skipped: { id: string; reason: string }[] }) => Promise<void> } = {}) {
    const today = await orgToday(db, actor.organizationId);
    const { ids, action, groupId, date: on } = input;
    const skipped: { id: string; reason: string }[] = [];
    let succeeded = 0;
    await db.transaction().execute(async (tx) => {
      await hooks.before?.(tx);
      await assertGroup(tx, actor, groupId);
      // Decided inside the transaction, with the memberships that give a scoped actor the right locked: a
      // concurrent removal from the actor's groups either waits for this transaction or is already seen.
      const scope = scopeOf(actor, 'members', 'write');
      const writable = new Set(
        scope === null
          ? (await tx.selectFrom('member').select('id').where('organization_id', '=', actor.organizationId).where('id', 'in', ids).execute()).map((r) => r.id)
          : scope.length === 0
            ? []
            : (await tx.selectFrom('group_membership').select('member_id').where('organization_id', '=', actor.organizationId).where('member_id', 'in', ids).where('group_id', 'in', scope).where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', today)])).forShare().execute()).map((r) => r.member_id),
      );
      for (const id of ids) {
        if (!writable.has(id)) {
          skipped.push({ id, reason: 'Nicht in Deinem Bereich oder nicht gefunden.' });
          continue;
        }
        if (action === 'add_to_group') {
          const overlap = await tx
            .selectFrom('group_membership')
            .select('id')
            .where('member_id', '=', id)
            .where('group_id', '=', groupId)
            .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', on)]))
            .executeTakeFirst();
          if (overlap) {
            skipped.push({ id, reason: 'Ist zu diesem Datum schon in der Gruppe.' });
            continue;
          }
          await tx.insertInto('group_membership').values({ organization_id: actor.organizationId, member_id: id, group_id: groupId, valid_from: on }).execute();
        } else {
          const res = await tx
            .updateTable('group_membership')
            .set({ valid_to: on })
            .where('member_id', '=', id)
            .where('group_id', '=', groupId)
            .where('valid_to', 'is', null)
            .where('valid_from', '<=', on)
            .executeTakeFirst();
          if (Number(res.numUpdatedRows) === 0) {
            skipped.push({ id, reason: 'Ist zu diesem Datum nicht in der Gruppe.' });
            continue;
          }
        }
        succeeded++;
      }
      await audit(tx, actor.organizationId, actor, { action: `member.bulk.${action}`, entityType: 'club_group', entityId: groupId, diff: { date: on, ids, succeeded, skipped: skipped.length } });
      await hooks.after?.(tx, { succeeded, skipped });
    });
  return { succeeded, skipped };
}
