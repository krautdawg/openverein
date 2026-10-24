import { Kysely, PostgresDialect, type Generated, type ColumnType, type Selectable } from 'kysely';
import pg from 'pg';

// DATE columns stay strings ("2026-03-01"): legal dates must never shift with time zones.
pg.types.setTypeParser(1082, (v) => v);
// BIGINT (money in cents, counts) fits a JS number for every realistic club amount.
pg.types.setTypeParser(20, (v) => Number(v));

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OrganizationTable {
  id: Generated<string>;
  name: string;
  time_zone: Generated<string>;
  is_demo: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AppUserTable {
  id: Generated<string>;
  organization_id: string;
  email: string;
  name: string;
  password_hash: string | null;
  status: Generated<'active' | 'disabled'>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionTable {
  token_hash: string;
  user_id: string;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: Date;
  user_agent: string | null;
}

export interface AuditEventTable {
  id: Generated<number>;
  organization_id: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  diff: unknown;
  at: Timestamp;
}

export interface Database {
  organization: OrganizationTable;
  app_user: AppUserTable;
  session: SessionTable;
  audit_event: AuditEventTable;
}

export type AppUser = Selectable<AppUserTable>;

export function createDb(connectionString: string) {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
}

export type Db = Kysely<Database>;
