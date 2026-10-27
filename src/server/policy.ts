import type { Db, Level } from './db.ts';
import { forbidden, Problem } from './http/problem.ts';

export const MODULES = ['members', 'groups', 'fees', 'invoices', 'sepa', 'banking', 'ledger', 'donations', 'communication', 'documents', 'events', 'settings', 'audit', 'imports', 'api'] as const;
export type Module = (typeof MODULES)[number];

/** Fields a role can hide. Restricted fields are left out of API responses, exports and search. */
export const RESTRICTABLE_FIELDS = ['iban', 'note', 'birth_date', 'email', 'phone', 'gender'] as const;

export interface Grant {
  roleId: string;
  roleName: string;
  permissions: Partial<Record<Module, Level>>;
  restricted: string[];
  /** null = whole organisation, otherwise the group ids the grant is limited to */
  scope: string[] | null;
  builtinKey?: string | null;
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
  /** 'token': a personal access token acting as this user (an agent): no step-up, no account self-service. */
  via?: 'token';
  /** Second factor of a signed-in user (absent for API tokens). */
  mfa?: { required: boolean; enrolled: boolean; at: Date | null };
}

/** Modules whose data or writes need the second factor (spec auth: finance roles). */
export const FINANCE_MODULES: Module[] = ['fees', 'invoices', 'sepa', 'banking', 'ledger', 'donations'];
const MFA_ROLES = ['tax_adviser', 'cash_auditor'];

/** Whether these grants oblige the user to use TOTP: write access to finance, or the tax-adviser / cash-auditor roles. */
export const mfaRequired = (grants: Grant[]) => grants.some((g) => MFA_ROLES.includes(g.builtinKey ?? '') || FINANCE_MODULES.some((m) => g.permissions[m] === 'write'));

const STEP_UP_MS = 10 * 60_000;
/**
 * Critical actions need a TOTP confirmation from the last ten minutes. API tokens are exempt: they carry no second factor
 * and are themselves created under step-up.
 */
export function requireStepUp(actor: Actor) {
  if (!actor.mfa) return;
  if (!actor.mfa.enrolled) throw new Problem(403, 'totp-required', 'Dafür brauchst Du die Anmeldung mit zweitem Faktor.', 'Richte sie unter Einstellungen → Sicherheit ein.');
  if (!actor.mfa.at || Date.now() - actor.mfa.at.getTime() > STEP_UP_MS) throw new Problem(403, 'step-up-required', 'Bitte bestätige mit Deinem Code aus der Authenticator-App.', 'Für diese Aktion muss die letzte Bestätigung jünger als zehn Minuten sein.');
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
  // Checked on every request, not only at sign-in: finance data stays closed until TOTP is set up.
  if (actor.mfa?.required && !actor.mfa.enrolled && FINANCE_MODULES.includes(module)) {
    throw new Problem(403, 'totp-required', 'Richte zuerst die Anmeldung mit zweitem Faktor ein.', 'Für Finanzdaten ist sie Pflicht (Einstellungen → Sicherheit).');
  }
}

/** Modules whose data belongs to the whole club (books, bank): a grant limited to groups is not enough. */
export function requireClubWide(actor: Actor, module: Module, need: Exclude<Level, 'none'>) {
  requirePermission(actor, module, need);
  if (scopeOf(actor, module, need) !== null) throw new Problem(403, 'forbidden', 'Dafür fehlt Dir die Berechtigung.', undefined, { permission: `${module}:${need} (ganzer Verein)` });
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
  const hidden = readers.length === 0 ? new Set<string>(RESTRICTABLE_FIELDS) : new Set<string>(RESTRICTABLE_FIELDS.filter((f) => readers.every((g) => g.restricted.includes(f))));
  // Columns that hold the same kind of data go with their field: the e-invoice address is an e-mail address.
  if (hidden.has('email')) hidden.add('einvoice_address');
  return hidden;
}

/** A signed-in user holding the built-in admin role for the whole club. */
/** Account self-service, keys and accesses are for the person at the keyboard: never an API key or an agent's token. */
export function requirePerson(actor: Actor) {
  if (actor.kind !== 'user' || actor.via === 'token') throw new Problem(403, 'person-required', 'Das geht nur angemeldet im Browser, nicht mit einem API-Schlüssel oder Agenten-Token.');
}

export const isClubAdmin = (actor: Actor) => actor.kind === 'user' && actor.grants.some((g) => g.builtinKey === 'admin' && g.scope === null);

export async function loadGrants(db: Db, userId: string): Promise<Grant[]> {
  const rows = await db
    .selectFrom('role_grant')
    .innerJoin('role', 'role.id', 'role_grant.role_id')
    .select(['role.id as roleId', 'role.name as roleName', 'role.builtin_key', 'role.permissions', 'role.restricted_fields', 'role_grant.scope_group_ids'])
    .where('role_grant.user_id', '=', userId)
    .execute();
  return rows.map((r) => ({ roleId: r.roleId, roleName: r.roleName, builtinKey: r.builtin_key, permissions: r.permissions, restricted: r.restricted_fields, scope: r.scope_group_ids }));
}
