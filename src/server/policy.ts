import type { Db, Level } from './db.ts';
import { forbidden } from './http/problem.ts';

export const MODULES = ['members', 'groups', 'fees', 'invoices', 'sepa', 'banking', 'ledger', 'donations', 'communication', 'documents', 'events', 'settings', 'audit', 'imports', 'api'] as const;
export type Module = (typeof MODULES)[number];

/** Fields a role can hide. Restricted fields are left out of API responses, exports and search. */
export const RESTRICTABLE_FIELDS = ['iban', 'note', 'birth_date', 'email', 'phone'] as const;

export interface Grant {
  roleId: string;
  roleName: string;
  permissions: Partial<Record<Module, Level>>;
  restricted: string[];
  /** null = whole organisation, otherwise the group ids the grant is limited to */
  scope: string[] | null;
}

export interface Actor {
  kind: 'user' | 'token';
  /** user id or token id */
  id: string;
  /** set for users, null for API tokens (audit_event.actor_user_id) */
  userId: string | null;
  name: string;
  organizationId: string;
  grants: Grant[];
}

const rank: Record<Level, number> = { none: 0, read: 1, write: 2 };

export function level(actor: Actor, module: Module): Level {
  let best: Level = 'none';
  for (const g of actor.grants) {
    const l = g.permissions[module] ?? 'none';
    if (rank[l] > rank[best]) best = l;
  }
  return best;
}

export const can = (actor: Actor, module: Module, need: Exclude<Level, 'none'>) => rank[level(actor, module)] >= rank[need];

export function requirePermission(actor: Actor, module: Module, need: Exclude<Level, 'none'>) {
  if (!can(actor, module, need)) throw forbidden(`${module}:${need}`);
}

/** Group scope for a module at a level: null means unrestricted. An unscoped grant wins over scoped ones. */
export function scopeOf(actor: Actor, module: Module, need: Exclude<Level, 'none'>): string[] | null {
  const groups = new Set<string>();
  for (const g of actor.grants) {
    if (rank[g.permissions[module] ?? 'none'] < rank[need]) continue;
    if (g.scope === null) return null;
    g.scope.forEach((id) => groups.add(id));
  }
  return [...groups];
}

/** A field is hidden only if every grant that can read the module hides it. */
export function restrictedFields(actor: Actor, module: Module = 'members'): Set<string> {
  const readers = actor.grants.filter((g) => rank[g.permissions[module] ?? 'none'] >= 1);
  if (readers.length === 0) return new Set(RESTRICTABLE_FIELDS);
  return new Set(RESTRICTABLE_FIELDS.filter((f) => readers.every((g) => g.restricted.includes(f))));
}

export async function loadGrants(db: Db, userId: string): Promise<Grant[]> {
  const rows = await db
    .selectFrom('role_grant')
    .innerJoin('role', 'role.id', 'role_grant.role_id')
    .select(['role.id as roleId', 'role.name as roleName', 'role.permissions', 'role.restricted_fields', 'role_grant.scope_group_ids'])
    .where('role_grant.user_id', '=', userId)
    .execute();
  return rows.map((r) => ({ roleId: r.roleId, roleName: r.roleName, permissions: r.permissions, restricted: r.restricted_fields, scope: r.scope_group_ids }));
}
