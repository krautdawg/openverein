-- Slice 0: organisation, users, sessions, append-only audit log.
-- Forward-only. Never edit a migration that has shipped; add a new one.

create table organization (
  id uuid primary key default uuidv7(),
  name text not null check (length(name) between 1 and 200),
  time_zone text not null default 'Europe/Berlin',
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app_user (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  email text not null,
  name text not null,
  password_hash text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  failed_logins int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index app_user_email_key on app_user (lower(email));

-- Only the SHA-256 of the session token is stored.
create table session (
  token_hash text primary key,
  user_id uuid not null references app_user(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index session_user_idx on session (user_id);

create table audit_event (
  id bigint generated always as identity primary key,
  organization_id uuid not null references organization(id),
  actor_user_id uuid references app_user(id),
  actor_label text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  diff jsonb,
  at timestamptz not null default now()
);
create index audit_event_entity_idx on audit_event (entity_type, entity_id);
create index audit_event_at_idx on audit_event using brin (at);

create function ov_reject_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end $$;

create trigger audit_event_append_only before update or delete on audit_event
  for each row execute function ov_reject_change();
create trigger audit_event_no_truncate before truncate on audit_event
  for each statement execute function ov_reject_change();
